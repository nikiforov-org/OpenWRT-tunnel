// tunnel_ddns captcha: picture challenges for a site's login page, generated on the router.
//
//   import { create, verify } from 'tunnel_ddns.captcha';
//
//   let c = create({ language: 'ru' });  // { id: '<32 hex digits>', png: '<base64 PNG>' },
//                                        // or null when too many challenges are waiting
//   verify(c.id, typed_text)             // true when the text is the answer to challenge c.id;
//                                        // a challenge can be verified only once
//
// The language selects an alphabet of captcha-font.json ('ru': Cyrillic capitals and digits,
// 'en': Latin capitals and digits; both leave out characters that look alike). The answer is
// compared without regard to case, and a Latin/Cyrillic look-alike typed on the wrong
// keyboard layout counts as the right letter.
//
// Open challenges are files in /tmp/tunnel_ddns/captcha/, valid for TTL seconds. The picture
// shows LENGTH characters, each in its own colour, size and tilt, bent along two waves and
// crossed by noise lines. It is an indexed-colour PNG assembled here without an image
// library (the pixel data is stored in an uncompressed deflate block).

'use strict';

import { open, readfile, writefile, lsdir, stat, unlink, mkdir, rename } from 'fs';
import { sin, cos, abs } from 'math';

const DIR       = '/tmp/tunnel_ddns/captcha';
const FONT_FILE = '/usr/share/tunnel_ddns/captcha-font.json';
const TTL       = 180;    // seconds a challenge may be answered
const MAX_OPEN  = 300;    // unanswered challenges kept at most
const LENGTH    = 5;      // characters per challenge
const WIDTH     = 200;    // picture size in pixels; (WIDTH + 1) * HEIGHT must stay below 65536
const HEIGHT    = 60;

const BACKGROUND = [ 245, 247, 250 ];
const COLOURS = [                                 // one per character, picked at random
	[ 200,  30,  40 ], [  20,  70, 200 ], [  10, 140,  70 ], [ 120,  30, 170 ], [ 220, 110,   0 ],
	[   0, 130, 140 ], [ 190,  20, 120 ], [ 110,  60,  10 ], [  30,  30, 130 ]
];

// Latin and Cyrillic capitals that look the same; either may be typed for the other
const LOOKALIKES = [
	[ 'A', 'А' ], [ 'B', 'В' ], [ 'C', 'С' ], [ 'E', 'Е' ], [ 'H', 'Н' ], [ 'K', 'К' ],
	[ 'M', 'М' ], [ 'O', 'О' ], [ 'P', 'Р' ], [ 'T', 'Т' ], [ 'X', 'Х' ], [ 'Y', 'У' ]
];

// ---- randomness from /dev/urandom ----

let entropy = '', entropy_used = 0;

// random integer in [0, n)
function random(n) {
	if (entropy_used + 2 > length(entropy)) {
		entropy = open('/dev/urandom', 'r').read(512);
		entropy_used = 0;
	}
	let value = (ord(entropy, entropy_used) << 8) | ord(entropy, entropy_used + 1);
	entropy_used += 2;
	return value % n;
}

// random real number in [low, high)
function random_between(low, high) {
	return low + (high - low) * random(10000) / 10000.0;
}

function round(value) {
	return int(value + (value < 0 ? -0.5 : 0.5));
}

// ---- text helpers ----

// the characters of a UTF-8 string, one array element each
function characters(text) {
	let out = [];
	for (let i = 0; i < length(text); ) {
		let lead = ord(text, i);
		let bytes = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
		push(out, substr(text, i, bytes));
		i += bytes;
	}
	return out;
}

// upper case for ASCII and Cyrillic letters
function upper(ch) {
	if (length(ch) == 1)
		return uc(ch);
	if (length(ch) == 2) {
		let b1 = ord(ch, 0), b2 = ord(ch, 1);
		if (b1 == 0xD0 && b2 >= 0xB0)                 // а … п
			return chr(0xD0, b2 - 0x20);
		if (b1 == 0xD1 && b2 >= 0x80 && b2 <= 0x8F)   // р … я
			return chr(0xD0, b2 + 0x20);
	}
	return ch;
}

// the text in a form where case, spaces and the keyboard layout of look-alikes do not matter
function canonical(text) {
	let out = '';
	for (let ch in characters(text)) {
		ch = upper(ch);
		for (let pair in LOOKALIKES)
			if (ch == pair[1])
				ch = pair[0];
		if (ch != ' ')
			out += ch;
	}
	return out;
}

// ---- PNG output: indexed colour, 8 bits per pixel, pixel data stored uncompressed ----

let CRC_TABLE = [];
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++)
		c = (c & 1) ? (0xEDB88320 ^ (c >> 1)) : (c >> 1);
	push(CRC_TABLE, c);
}

// CRC-32 continued over the bytes of a string (start with 0xFFFFFFFF, finish with ^ 0xFFFFFFFF)
function crc32_update(crc, data) {
	for (let i = 0; i < length(data); i++)
		crc = CRC_TABLE[(crc ^ ord(data, i)) & 0xFF] ^ (crc >> 8);
	return crc;
}

function uint32(n) {
	return chr((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function uint16le(n) {
	return chr(n & 255, (n >> 8) & 255);
}

function chunk(type, data) {
	return uint32(length(data)) + type + data + uint32(crc32_update(0xFFFFFFFF, type + data) ^ 0xFFFFFFFF);
}

// the IDAT chunk: every row as a scanline (filter byte 0, then one palette index per pixel)
// inside a zlib stream with a single stored block; the chunk's CRC-32 and the stream's
// Adler-32 are computed from the pixel arrays in the same pass
function pixel_chunk(rows) {
	let size = HEIGHT * (WIDTH + 1);
	let head = chr(0x78, 0x01, 1) + uint16le(size) + uint16le(~size & 0xFFFF);
	let crc = crc32_update(0xFFFFFFFF, 'IDAT' + head);
	let a = 1, b = 0;
	let scanlines = [];
	for (let row in rows) {
		push(scanlines, chr(0, ...row));
		crc = CRC_TABLE[crc & 0xFF] ^ (crc >> 8);
		b += a;
		for (let v in row) {
			crc = CRC_TABLE[(crc ^ v) & 0xFF] ^ (crc >> 8);
			a += v;
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	let adler = uint32((b << 16) | a);
	let data = head + join('', scanlines) + adler;
	return uint32(length(data)) + 'IDAT' + data + uint32(crc32_update(crc, adler) ^ 0xFFFFFFFF);
}

function png(rows, palette) {
	let plte = '';
	for (let colour in palette)
		plte += chr(colour[0], colour[1], colour[2]);
	return chr(0x89) + 'PNG' + chr(13, 10, 26, 10)
		+ chunk('IHDR', uint32(WIDTH) + uint32(HEIGHT) + chr(8, 3, 0, 0, 0))
		+ chunk('PLTE', plte)
		+ pixel_chunk(rows)
		+ chunk('IEND', '');
}

// ---- drawing: the picture is an array of rows, each an array of palette indexes ----

function blank_picture() {
	let zero_row = [];
	for (let x = 0; x < WIDTH; x++)
		push(zero_row, 0);
	let rows = [];
	for (let y = 0; y < HEIGHT; y++)
		push(rows, slice(zero_row));
	return rows;
}

// a glyph of the font as rows of booleans
function glyph_bits(glyph) {
	return map(glyph, row => map(split(row, ''), ch => ch == '#'));
}

// the vertical bend: how far down every column is shifted, along a sine wave
function vertical_bend() {
	let amplitude = random_between(1.5, 3), period = random_between(22, 44), phase = random_between(0, 6.28);
	let bend = [];
	for (let x = 0; x < WIDTH; x++)
		push(bend, round(amplitude * sin(x / period + phase)));
	return bend;
}

// paints a glyph centred at (cx, cy), scaled and tilted by `angle` radians, following the
// bend: for every target pixel the matching glyph pixel is looked up, so the shape stays solid
function draw_glyph(rows, bits, cx, cy, scale, angle, bend, colour) {
	let glyph_w = length(bits[0]), glyph_h = length(bits);
	let c = cos(angle), s = sin(angle);
	let half_w = int((glyph_w * abs(c) + glyph_h * abs(s)) * scale / 2) + 1;
	let half_h = int((glyph_w * abs(s) + glyph_h * abs(c)) * scale / 2) + 4;
	for (let x = cx - half_w; x <= cx + half_w; x++) {
		if (x < 0 || x >= WIDTH)
			continue;
		let dx = x - cx;
		for (let y = cy - half_h; y <= cy + half_h; y++) {
			if (y < 0 || y >= HEIGHT)
				continue;
			let dy = y - bend[x] - cy;
			let gx = (dx * c + dy * s) / scale + glyph_w / 2.0;
			let gy = (dy * c - dx * s) / scale + glyph_h / 2.0;
			if (gx >= 0 && gx < glyph_w && gy >= 0 && gy < glyph_h && bits[int(gy)][int(gx)])
				rows[y][x] = colour;
		}
	}
}

// a straight line two pixels thick, following the bend
function draw_line(rows, x0, y0, x1, y1, bend, colour) {
	let steps = abs(x1 - x0) > abs(y1 - y0) ? abs(x1 - x0) : abs(y1 - y0);
	for (let i = 0; i <= steps; i++) {
		let x = round(x0 + (x1 - x0) * i / (steps || 1.0));
		let y = round(y0 + (y1 - y0) * i / (steps || 1.0)) + bend[x];
		for (let t = y; t <= y + 1; t++)
			if (t >= 0 && t < HEIGHT)
				rows[t][x] = colour;
	}
}

// shifts every row sideways along a sine wave
function wave_rows(rows) {
	let amplitude = random_between(2, 4), period = random_between(14, 26), phase = random_between(0, 6.28);
	for (let y = 0; y < HEIGHT; y++) {
		let shift = round(amplitude * sin(y / period + phase));
		if (shift > 0) {
			rows[y] = slice(rows[y], shift);
			for (let i = 0; i < shift; i++)
				push(rows[y], 0);
		}
		else if (shift < 0) {
			rows[y] = slice(rows[y], 0, WIDTH + shift);
			for (let i = 0; i < -shift; i++)
				unshift(rows[y], 0);
		}
	}
}

// the picture for `answer`: characters left to right, each in its own colour, size and
// tilt, with noise lines, all bent vertically; then the rows are shifted along another wave
function picture(answer, font) {
	let palette = [ BACKGROUND ];
	let unused_colours = [ ...COLOURS ];
	let rows = blank_picture();
	let bend = vertical_bend();
	let chars = characters(answer);
	let margin = 12, step = (WIDTH - 2 * margin) / length(chars);
	for (let i = 0; i < length(chars); i++) {
		let pick = random(length(unused_colours));
		push(palette, unused_colours[pick]);
		splice(unused_colours, pick, 1);
		let cx = margin + step * i + step / 2 + random(7) - 3;
		let cy = HEIGHT / 2 + random(9) - 4;
		draw_glyph(rows, glyph_bits(font.glyphs[chars[i]]), cx, cy,
			random_between(0.9, 1.2), random_between(-0.35, 0.35), bend, length(palette) - 1);
	}
	for (let i = 0; i < 4; i++)
		draw_line(rows, random(WIDTH), random(HEIGHT), random(WIDTH), random(HEIGHT), bend, 1 + random(length(palette) - 1));
	wave_rows(rows);
	for (let i = 0; i < 60; i++)
		rows[random(HEIGHT)][random(WIDTH)] = 1 + random(length(palette) - 1);
	return png(rows, palette);
}

// ---- challenges ----

// deletes expired challenges; returns how many are still open
function tidy() {
	let now = time(), open_count = 0;
	for (let name in lsdir(DIR)) {
		let path = `${DIR}/${name}`;
		let info = stat(path);
		if (info && now - info.mtime > TTL)
			unlink(path);
		else
			open_count++;
	}
	return open_count;
}

function create(options) {
	let font = json(readfile(FONT_FILE));
	let alphabet = characters(font.alphabets[options?.language] ?? font.alphabets.en);
	mkdir('/tmp/tunnel_ddns', 0o755);
	mkdir(DIR, 0o700);
	if (tidy() >= MAX_OPEN)
		return null;
	let answer = '';
	for (let i = 0; i < LENGTH; i++)
		answer += alphabet[random(length(alphabet))];
	let id = hexenc(open('/dev/urandom', 'r').read(16));
	writefile(`${DIR}/${id}`, answer);          // the file's mtime dates the challenge
	return { id, png: b64enc(picture(answer, font)) };
}

function verify(id, text) {
	if (type(id) != 'string' || !match(id, /^[0-9a-f]{32}$/))
		return false;
	let path = `${DIR}/${id}`;
	let info = stat(path);
	if (!info || !rename(path, `${path}.taken`))       // unknown, or claimed by a parallel request
		return false;
	let answer = readfile(`${path}.taken`);
	unlink(`${path}.taken`);
	if (time() - info.mtime > TTL)
		return false;
	return canonical(text ?? '') == canonical(answer);
}

export { create, verify };
