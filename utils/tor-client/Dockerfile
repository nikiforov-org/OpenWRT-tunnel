# The tor client used by tor-client: tor (SOCKS on 127.0.0.1:9050 inside the container) and socat
# (the SSH proxy command). The torrc and the client keys are written by tor-client at every run.
FROM alpine:3.22
RUN apk add --no-cache tor socat \
 && mkdir -p /etc/tor/auth \
 && chown -R tor:tor /var/lib/tor /etc/tor/auth \
 && chmod 700 /var/lib/tor /etc/tor/auth
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT [ "/bin/sh", "/entrypoint.sh" ]
