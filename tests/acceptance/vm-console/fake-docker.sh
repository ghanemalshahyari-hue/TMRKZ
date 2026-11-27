#!/bin/sh
# Stand-in for `docker` in the MOVER VM helper tests (mover-vm.sh reads MOVER_DOCKER). It plays one MOVER compose project
# from the files of the scenario folder $SCN; every call is appended to $SCN/calls.
#   web-port / proxy-port   host ports published for web:5006 / proxy:8443 (no file = not published)
#   wc                      gunicorn --worker-connections (no file = waitress, one process)
#   services                the other services that run (one per line)
#   web.log, <svc>.log      what `compose logs --since 60m` prints
#   stats                   what one `stats --no-stream` sample prints ("name cpu% mem%")
#   env                     web's environment (only TNQL_WEB_* / MOVER_PAGE_PROFILE are read)
#   restarts                "service count" lines
#   fix-wc                  the worker-connections web gets when it is recreated
echo "$*" >> "$SCN/calls"
svcs() { echo web; [ -f "$SCN/proxy-port" ] && echo proxy; cat "$SCN/services" 2>/dev/null; }
if [ "$1" = compose ]; then
    shift
    case "$1" in
        ps)
            shift
            if [ "${1:-}" = -q ]; then
                if [ -n "${2:-}" ]; then svcs | grep -qx "$2" && echo "id-$2"; else svcs | sed 's/^/id-/'; fi
            elif [ "${1:-}" = --format ]; then
                case "$2" in *Name*) svcs | awk '{print "mover-" $1 "-1 " $1}' ;; *) svcs | awk '{print $1 "\tUp 2 hours\tmover:1"}' ;; esac
            fi ;;
        port)
            case "$2" in web) f=web-port ;; proxy) f=proxy-port ;; *) f=none ;; esac
            [ -f "$SCN/$f" ] && echo "0.0.0.0:$(cat "$SCN/$f")" ;;
        logs)
            s=$(eval "echo \${$#}"); cat "$SCN/$s.log" 2>/dev/null ;;
        up)
            # web recreated: it takes the fixed connection limit and answers quickly again
            [ -f "$SCN/fix-wc" ] && cp "$SCN/fix-wc" "$SCN/wc"
            touch "$SCN/healed"; echo " Container mover-web-1  Started" ;;
        restart) : ;;
    esac
    exit 0
fi
case "$1" in
    top)
        if [ -f "$SCN/wc" ]; then
            echo "COMMAND"; echo "gunicorn --bind 0.0.0.0:5006 --workers 4 --worker-class gthread --threads 128 --worker-connections $(cat "$SCN/wc") --timeout 150"
        else
            echo "COMMAND"; echo "waitress-serve --listen=0.0.0.0:5006 --threads=128 --connection-limit=512 app.wsgi:app"
        fi ;;
    inspect)
        f=$3; id=$4; s=${id#id-}
        case "$f" in
            *Config.Env*) cat "$SCN/env" 2>/dev/null ;;
            *RestartCount*) echo "$s $(awk -v s="$s" '$1 == s {print $2}' "$SCN/restarts" 2>/dev/null | grep . || echo 0) running healthy" ;;
            *State.Health*) echo healthy ;;
        esac ;;
    stats) cat "$SCN/stats" 2>/dev/null ;;
esac
exit 0
