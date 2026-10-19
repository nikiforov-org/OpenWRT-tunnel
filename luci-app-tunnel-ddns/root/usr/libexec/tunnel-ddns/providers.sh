# Provider table of tunnel-ddns. Sourced by sync and cert.
#
# tdd_provider_ddns SECTION  sets TDD_SERVICE TDD_DOMAIN TDD_USER TDD_PASS TDD_PARAM_OPT
#                            for the ddns-scripts service section (returns 1 if unknown)
# tdd_provider_acme SECTION  sets TDD_HOOK, TDD_DNSSLEEP (seconds to wait for DNS propagation
#                            instead of polling public resolvers; empty = poll) and exports the
#                            acme.sh hook variables (returns 1 if unknown)

_tdd_get() {
	uci -q get "tunnel-ddns.$1.$2"
}

tdd_provider_ddns() {
	local sid="$1" host provider zone
	host="$(_tdd_get "$sid" hostname)"
	provider="$(_tdd_get "$sid" provider)"
	TDD_SERVICE=""; TDD_DOMAIN="$host"; TDD_USER=""; TDD_PASS=""; TDD_PARAM_OPT=""
	case "$provider" in
	duckdns)
		TDD_SERVICE=duckdns.org
		TDD_DOMAIN="${host%.duckdns.org}"
		TDD_PASS="$(_tdd_get "$sid" duckdns_token)"
		;;
	dynv6)
		TDD_SERVICE=dynv6.com
		TDD_PASS="$(_tdd_get "$sid" dynv6_token)"
		;;
	ipv64)
		TDD_SERVICE=ipv64.net
		TDD_PASS="$(_tdd_get "$sid" ipv64_ddns_key)"
		;;
	dnsexit)
		TDD_SERVICE=dnsexit.com
		TDD_USER="$(_tdd_get "$sid" dnsexit_user)"
		TDD_PASS="$(_tdd_get "$sid" dnsexit_password)"
		;;
	mydnsjp)
		TDD_SERVICE=mydns.jp
		TDD_USER="$(_tdd_get "$sid" mydnsjp_master_id)"
		TDD_PASS="$(_tdd_get "$sid" mydnsjp_password)"
		;;
	beget)
		TDD_SERVICE=beget.com
		TDD_USER="$(_tdd_get "$sid" beget_login)"
		TDD_PASS="$(_tdd_get "$sid" beget_api_password)"
		;;
	cloudflare)
		TDD_SERVICE=cloudflare.com-v4
		TDD_USER=Bearer
		TDD_PASS="$(_tdd_get "$sid" cf_token)"
		zone="$(_tdd_get "$sid" cf_zone_id)"
		[ -n "$zone" ] && TDD_PARAM_OPT="zone_id=$zone"
		;;
	*)
		return 1
		;;
	esac
	return 0
}

tdd_provider_acme() {
	local sid="$1" provider zone
	provider="$(_tdd_get "$sid" provider)"
	TDD_HOOK=""
	TDD_DNSSLEEP=""
	case "$provider" in
	duckdns)
		TDD_HOOK=dns_duckdns
		export DuckDNS_Token="$(_tdd_get "$sid" duckdns_token)"
		;;
	dynv6)
		TDD_HOOK=dns_dynv6
		export DYNV6_TOKEN="$(_tdd_get "$sid" dynv6_token)"
		;;
	ipv64)
		TDD_HOOK=dns_ipv64
		export IPv64_Token="$(_tdd_get "$sid" ipv64_api_key)"
		;;
	dnsexit)
		TDD_HOOK=dns_dnsexit
		export DNSEXIT_API_KEY="$(_tdd_get "$sid" dnsexit_api_key)"
		export DNSEXIT_AUTH_USER="$(_tdd_get "$sid" dnsexit_user)"
		export DNSEXIT_AUTH_PASS="$(_tdd_get "$sid" dnsexit_password)"
		;;
	mydnsjp)
		TDD_HOOK=dns_mydnsjp
		export MYDNSJP_MasterID="$(_tdd_get "$sid" mydnsjp_master_id)"
		export MYDNSJP_Password="$(_tdd_get "$sid" mydnsjp_password)"
		;;
	beget)
		TDD_HOOK=dns_begetdns
		TDD_DNSSLEEP=60
		export Beget_Username="$(_tdd_get "$sid" beget_login)"
		export Beget_Password="$(_tdd_get "$sid" beget_api_password)"
		;;
	cloudflare)
		TDD_HOOK=dns_cf
		export CF_Token="$(_tdd_get "$sid" cf_token)"
		zone="$(_tdd_get "$sid" cf_zone_id)"
		[ -n "$zone" ] && export CF_Zone_ID="$zone"
		;;
	*)
		return 1
		;;
	esac
	return 0
}
