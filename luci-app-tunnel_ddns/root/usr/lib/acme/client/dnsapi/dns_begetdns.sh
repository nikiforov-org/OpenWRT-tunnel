#!/usr/bin/env sh
# shellcheck disable=SC2034
dns_begetdns_info='Beget.com (DNS API group only)
 Uses only dns/changeRecords, so the API password may be restricted to the "DNS" group.
Site: beget.com
Docs: https://beget.com/en/kb/api/dns-administration-functions
Options:
 Beget_Username Account login
 Beget_Password API password (Account settings - Access restriction)
'

Beget_Api="https://api.beget.com/api"

# Usage: dns_begetdns_add _acme-challenge.www.example.org "txt-value"
dns_begetdns_add() {
  fulldomain=$1
  txtvalue=$2
  _begetdns_init || return 1
  _info "Adding TXT record for $fulldomain"
  _begetdns_change "$fulldomain" "{\"TXT\":[{\"priority\":10,\"value\":\"$txtvalue\"}]}" || return 1
  _begetdns_wait "$fulldomain" "$txtvalue"
}

# Usage: dns_begetdns_rm _acme-challenge.www.example.org "txt-value"
dns_begetdns_rm() {
  fulldomain=$1
  _begetdns_init || return 1
  _info "Removing TXT record for $fulldomain"
  _begetdns_change "$fulldomain" "{}"
}

####################  Private functions below ##################################

# Beget's name servers pick up changes unevenly and Let's Encrypt validates from several
# places, so wait until every authoritative name server of the zone answers with the record.
_begetdns_wait() {
  _name="$1"
  _txt="$2"
  _zone="$_name"
  _nslist=""
  while [ -n "$_zone" ]; do
    _nslist="$(nslookup -type=ns "$_zone" 2>/dev/null | sed -n 's/.*nameserver = //p' | sed 's/\.$//')"
    [ -n "$_nslist" ] && break
    case "$_zone" in
    *.*) _zone="${_zone#*.}" ;;
    *) _zone="" ;;
    esac
  done
  if [ -z "$_nslist" ]; then
    _info "Could not find the name servers of $_name, not waiting for propagation."
    return 0
  fi
  _info "Waiting until the TXT record is visible on all name servers of $_zone: $(echo $_nslist | tr '\n' ' ')"
  _deadline=$(($(date +%s) + 420))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _ok=1
    for _ns in $_nslist; do
      nslookup -type=txt "$_name" "$_ns" 2>/dev/null | grep -qF "$_txt" || {
        _ok=0
        break
      }
    done
    if [ "$_ok" = 1 ]; then
      _info "The TXT record is visible on all name servers."
      return 0
    fi
    sleep 10
  done
  _info "Gave up waiting for propagation after 7 minutes, continuing anyway."
  return 0
}

_begetdns_init() {
  Beget_Username="${Beget_Username:-$(_readaccountconf_mutable Beget_Username)}"
  Beget_Password="${Beget_Password:-$(_readaccountconf_mutable Beget_Password)}"
  if [ -z "$Beget_Username" ] || [ -z "$Beget_Password" ]; then
    Beget_Username=""
    Beget_Password=""
    _err "You did not specify Beget_Username and Beget_Password."
    return 1
  fi
  _saveaccountconf_mutable Beget_Username "$Beget_Username"
  _saveaccountconf_mutable Beget_Password "$Beget_Password"
  return 0
}

# _begetdns_change fqdn records-json: replaces all user records of the name
_begetdns_change() {
  _fqdn=$1
  _records=$2
  _input="{\"fqdn\":\"$_fqdn\",\"records\":$_records}"
  _data="login=$(printf '%s' "$Beget_Username" | _url_encode)&passwd=$(printf '%s' "$Beget_Password" | _url_encode)&input_format=json&output_format=json&input_data=$(printf '%s' "$_input" | _url_encode)"
  _response="$(_post "$_data" "$Beget_Api/dns/changeRecords")"
  _debug2 response "$_response"
  if _contains "$_response" '"result":true'; then
    return 0
  fi
  _err "Beget dns/changeRecords failed: $_response"
  return 1
}
