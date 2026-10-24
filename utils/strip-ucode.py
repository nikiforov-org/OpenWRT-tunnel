#!/usr/bin/env python3
"""Removes the comment lines and blank lines of ucode scripts and modules for the package build.

utils/build.sh runs it on the copy of a package tree inside the build container: every *.uc file and
every file starting with a ucode interpreter line. A line goes when it is blank or holds only a //
comment and the scanner is in code there (not inside a string, a template or a regular expression);
block comments, comments after code and the interpreter line stay. The literals (strings, templates,
regular expressions) of the result must equal those of the source, else the file is left unchanged.
  strip-ucode.py DIR...
"""
import os
import sys

REGEX_AFTER = set('(,=:[!&|?{};+-*%<>~^') | {''}
REGEX_KEYWORDS = {'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw'}


def scan(src):
	"""-> (literals, code_line_starts): the literal texts in order and the offsets of the lines that
	begin in code."""
	literals, starts = [], {0}
	i, n = 0, len(src)
	stack = []           # template nesting: the brace depth at which each ${...} started
	depth = 0
	prev = ''            # the last significant character or word outside literals

	def string(i, q):
		j = i + 1
		while j < n and src[j] != q:
			j += 2 if src[j] == '\\' else 1
		return j + 1

	def template(i):
		# from the character after a backtick (or after the } closing ${...}) to the backtick or ${
		j = i
		while j < n:
			if src[j] == '\\':
				j += 2
			elif src[j] == '`':
				return j + 1, False
			elif src.startswith('${', j):
				return j + 2, True
			else:
				j += 1
		return n, False

	def regex(i):
		j, cls = i + 1, False
		while j < n and src[j] != '\n':
			c = src[j]
			if c == '\\':
				j += 2
				continue
			if c == '[':
				cls = True
			elif c == ']':
				cls = False
			elif c == '/' and not cls:
				j += 1
				while j < n and (src[j].isalnum() or src[j] == '_'):
					j += 1
				return j
			j += 1
		return -1

	while i < n:
		c = src[i]
		if c == '\n':
			starts.add(i + 1)
			i += 1
			continue
		if c in ' \t\r':
			i += 1
			continue
		if src.startswith('//', i):
			j = src.find('\n', i)
			i = n if j < 0 else j
			continue
		if src.startswith('/*', i):
			j = src.find('*/', i + 2)
			i = n if j < 0 else j + 2
			continue
		if c in '"\'':
			j = string(i, c)
			literals.append(src[i:j])
			i, prev = j, 'lit'
			continue
		if c == '`':
			j, opened = template(i + 1)
			literals.append(src[i:j])
			if opened:
				stack.append(depth)
			i, prev = j, 'lit'
			continue
		if c == '}' and stack and depth == stack[-1]:
			stack.pop()
			j, opened = template(i + 1)
			literals.append(src[i:j])
			if opened:
				stack.append(depth)
			i, prev = j, 'lit'
			continue
		if c == '/' and (prev in REGEX_AFTER or prev in REGEX_KEYWORDS):
			j = regex(i)
			if j > 0:
				literals.append(src[i:j])
				i, prev = j, 'lit'
				continue
		if c.isalnum() or c in '_$':
			j = i
			while j < n and (src[j].isalnum() or src[j] in '_$'):
				j += 1
			prev = src[i:j]
			i = j
			continue
		if c == '{':
			depth += 1
		elif c == '}':
			depth -= 1
		prev = c
		i += 1
	return literals, starts


def strip(src):
	literals, starts = scan(src)
	out, pos = [], 0
	for line in src.split('\n'):
		keep = True
		if pos in starts and pos != 0:
			s = line.strip()
			if s == '' or s.startswith('//'):
				keep = False
		elif pos == 0 and not line.startswith('#!'):
			s = line.strip()
			if s == '' or s.startswith('//'):
				keep = False
		if keep:
			out.append(line)
		pos += len(line) + 1
	result = '\n'.join(out)
	if not result.endswith('\n'):
		result += '\n'
	if scan(result)[0] != literals:
		return None
	return result


def is_ucode(path):
	if path.endswith('.uc'):
		return True
	try:
		with open(path, 'rb') as f:
			head = f.readline()
	except OSError:
		return False
	return head.startswith(b'#!') and b'ucode' in head


def main(dirs):
	before = after = files = 0
	for d in dirs:
		for root, _, names in os.walk(d):
			for name in names:
				path = os.path.join(root, name)
				if name.startswith('._') or os.path.islink(path) or not is_ucode(path):
					continue
				src = open(path, encoding='utf-8').read()
				res = strip(src)
				if res is None:
					print('strip-ucode: %s left as it is (the literals would change)' % path, file=sys.stderr)
					continue
				if res != src:
					with open(path, 'w', encoding='utf-8') as f:
						f.write(res)
				files += 1
				before += len(src.encode())
				after += len(res.encode())
	print('strip-ucode: %d files, %d -> %d bytes' % (files, before, after))


if __name__ == '__main__':
	main(sys.argv[1:])
