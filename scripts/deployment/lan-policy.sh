#!/usr/bin/env bash
# Scriptarr-owned policy; only the explicitly assigned LAN application ports are affected.
set -euo pipefail
case "${1:-}" in
  core) address=192.168.50.6; ports='3004 4401' ;;
  ai) address=192.168.50.7; ports='3001 3003 4401' ;;
  *) printf 'Usage: lan-policy.sh core|ai\n' >&2; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'Root is required for the Docker forwarding policy.' >&2; exit 1; }
for attempt in $(seq 1 120); do
  if iptables -w 5 -nL DOCKER-USER >/dev/null 2>&1; then break; fi
  sleep 2
done
iptables -w 5 -nL DOCKER-USER >/dev/null
iptables -w 5 -N SCRIPTARR-LAN 2>/dev/null || true
# Flush only the dedicated chain. Reapplying never rewrites unrelated Docker or host rules.
iptables -w 5 -F SCRIPTARR-LAN
for port in $ports; do
  if [ "$port" = 4401 ]; then
    sources='192.168.50.6'
  elif [ "$1" = core ]; then
    sources='192.168.50.6 192.168.50.7'
  else
    sources='192.168.50.6 192.168.50.7 192.168.50.14'
  fi
  for source in $sources; do
    # Original tuples match both the request and its DNAT reply. An exact allow
    # must terminate here so other applications' published-port guards do not
    # reject an authorized Scriptarr connection further down DOCKER-USER.
    iptables -w 5 -A SCRIPTARR-LAN -p tcp -m conntrack --ctorigsrc "$source" --ctorigdst "$address" --ctorigdstport "$port" -j ACCEPT
  done
  iptables -w 5 -A SCRIPTARR-LAN -p tcp -m conntrack --ctorigdst "$address" --ctorigdstport "$port" -j DROP
done
iptables -w 5 -A SCRIPTARR-LAN -j RETURN
iptables -w 5 -C DOCKER-USER -j SCRIPTARR-LAN 2>/dev/null || iptables -w 5 -I DOCKER-USER 1 -j SCRIPTARR-LAN
printf 'Scriptarr LAN policy applied for %s\n' "$1"
