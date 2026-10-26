#!/bin/sh
# tor.sh OUT: tor, the version of the tor package of OpenWrt 25.12 with that package's configure options
# and without the relay module (as tor-basic), linked statically with LibreSSL, libevent and zlib, built
# with the toolchain of the OpenWrt SDK this runs in (xtunnel-core/build.sh starts it in the SDK images) to
# OUT/tor. One file instead of tor, libopenssl3 and libevent2.
set -eu
OUT=$1
TOR=0.4.9.13       TOR_SHA=5e748d3272cdf44a7d7741173f371c8def3d96eecb77e93c89c50663ce9cc792
LIBRESSL=4.3.4     LIBRESSL_SHA=57c8b2f8c6f9505587abaeddab003ea243d615edb7ed71957968121fc6316bd6
LIBEVENT=2.1.12    LIBEVENT_SHA=92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb
ZLIB=1.3.1         ZLIB_SHA=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

T=$(ls -d /builder/staging_dir/toolchain-*)
export STAGING_DIR=/builder/staging_dir PATH="$T/bin:$PATH"
HOST=$(cd "$T/bin" && ls *-openwrt-linux-musl-gcc | sed 's/-gcc$//')
W=/tmp/tor-build; P=$W/prefix
mkdir -p $W/src $P
fetch() {   # fetch URL SHA256
	f=$W/src/$(basename "$1")
	[ -f "$f" ] || wget -q -O "$f" "$1"
	echo "$2  $f" | sha256sum -c - >/dev/null || { echo "tor.sh: wrong checksum of $f" >&2; exit 1; }
	tar -xzf "$f" -C $W
}
fetch https://dist.torproject.org/tor-$TOR.tar.gz $TOR_SHA
fetch https://cdn.openbsd.org/pub/OpenBSD/LibreSSL/libressl-$LIBRESSL.tar.gz $LIBRESSL_SHA
fetch https://github.com/libevent/libevent/releases/download/release-$LIBEVENT-stable/libevent-$LIBEVENT-stable.tar.gz $LIBEVENT_SHA
fetch https://zlib.net/fossils/zlib-$ZLIB.tar.gz $ZLIB_SHA

# A tor client keeps a heap copy of every microdescriptor that sits in the journal (cached-microdescs.new)
# until it rebuilds the cache file, which it does every 30 minutes (clean_caches_callback): a start without
# a cache held ~48 MB of copies on the ZTE MF286R (120 MB of RAM). Rebuild as soon as the journal exceeds
# 8 MB, checked whenever the descriptor downloads are updated (every 10 s while fetching).
MD=$W/tor-$TOR/src/feature/nodelist/microdesc.c
sed -i 's|^  pending = digest256map_new();$|  if (get_microdesc_cache()->journal_len > (8 * 1024 * 1024))\n    microdesc_cache_rebuild(NULL, 1);\n\n&|' $MD
grep -q 'journal_len > (8 \* 1024 \* 1024)' $MD || { echo "tor.sh: the microdesc patch did not apply" >&2; exit 1; }

case $HOST in aarch64-*) ARCH_CFLAGS='-march=armv8-a' ;; mips-*) ARCH_CFLAGS='-mips32r2 -mtune=24kc -mno-branch-likely' ;; *) ARCH_CFLAGS='' ;; esac
export CC=$HOST-gcc AR=$HOST-ar RANLIB=$HOST-ranlib
export CFLAGS="-Os -pipe $ARCH_CFLAGS -ffunction-sections -fdata-sections -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIC"
export LDFLAGS="-Wl,--gc-sections -Wl,-z,now -Wl,-z,relro"
J=$(nproc)

(cd $W/zlib-$ZLIB && ./configure --static --prefix=$P >/dev/null && make -j$J >/dev/null && make install >/dev/null)
(cd $W/libevent-$LIBEVENT-stable && ./configure --host=$HOST --prefix=$P --disable-shared --enable-static \
	--disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode >/dev/null &&
	make -j$J >/dev/null && make install >/dev/null)
(cd $W/libressl-$LIBRESSL && ./configure --host=$HOST --prefix=$P --disable-shared --enable-static --disable-tests >/dev/null &&
	make -j$J -C crypto >/dev/null && make -j$J -C ssl >/dev/null &&
	make -C crypto install >/dev/null && make -C ssl install >/dev/null && make -C include install >/dev/null)
(cd $W/tor-$TOR && CROSS_COMPILE=yes ac_cv_func_mallinfo=no CFLAGS="$CFLAGS -DDISABLE_ENGINES" ./configure --host=$HOST \
	--prefix=/usr --sysconfdir=/etc --localstatedir=/var \
	--enable-static-openssl --with-openssl-dir=$P --enable-static-libevent --with-libevent-dir=$P \
	--enable-static-zlib --with-zlib-dir=$P --disable-module-relay \
	--disable-asciidoc --disable-html-manual --disable-manpage --disable-seccomp --disable-libscrypt \
	--disable-unittests --disable-lzma --disable-zstd --with-tor-user=tor --with-tor-group=tor --enable-pic >$W/tor-configure.log 2>&1 ||
	{ tail -20 $W/tor-configure.log; exit 1; }
	make -j$J src/app/tor >$W/tor-make.log 2>&1 || { tail -20 $W/tor-make.log; exit 1; })
mkdir -p "$OUT"
$HOST-strip -o "$OUT/tor" $W/tor-$TOR/src/app/tor
echo "tor $TOR with LibreSSL $LIBRESSL for $HOST: $(stat -c %s "$OUT/tor") bytes"
