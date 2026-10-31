# POSIX helpers shared by the installation and doctor scripts.
#
# This file deliberately contains no terminal-multiplexer or legacy `herdr`
# calls. herdr-core owns terminal execution; the optional herdr-app mod owns
# popup presentation. Installers only read local configuration and report.

# replace_all <from> <to>
# Read text on standard input and print it with every literal <from> replaced
# by <to>. Values are passed through the environment so awk does not
# reinterpret backslashes or ampersands.
replace_all() {
  FROM=$1 TO=$2 awk '
    BEGIN { from = ENVIRON["FROM"]; to = ENVIRON["TO"] }
    {
      if (from == "") { print; next }
      line = $0
      out = ""
      while ((i = index(line, from)) > 0) {
        out = out substr(line, 1, i - 1) to
        line = substr(line, i + length(from))
      }
      print out line
    }'
}

# json_field <json> <key>: one top-level string/number/bool field.
json_field() {
  case "${AVEN_JSON_BACKEND:-auto}" in
    awk) backend=awk ;;
    jq) backend=jq ;;
    python3) backend=python3 ;;
    *) if command -v jq >/dev/null 2>&1; then backend=jq; elif command -v python3 >/dev/null 2>&1; then backend=python3; else backend=awk; fi ;;
  esac
  case "$backend" in
    jq) printf '%s' "$1" | jq -r --arg p "$2" 'getpath([$p]) // ""' 2>/dev/null ;;
    python3) printf '%s' "$1" | python3 -c 'import json,sys
try: data=json.load(sys.stdin)
except Exception: data={}
value=data.get(sys.argv[1]) if isinstance(data, dict) else None
if value is None: print("")
else: print(value if isinstance(value, str) else json.dumps(value))' "$2" 2>/dev/null ;;
    awk)
      printf '%s' "$1" | awk -v key="$2" '
        {
          line = $0; n = length(line); depth = 0; i = 1
          while (i <= n) {
            c = substr(line, i, 1)
            if (c == "\"") {
              j = i + 1
              while (j <= n && substr(line, j, 1) != "\"") j++
              text = substr(line, i + 1, j - i - 1)
              i = j + 1
              if (depth == 1 && text == key) {
                while (i <= n && substr(line, i, 1) ~ /[ \t:]/) i++
                if (i > n) { print ""; exit }
                if (substr(line, i, 1) == "\"") {
                  j = i + 1
                  while (j <= n && substr(line, j, 1) != "\"") j++
                  print substr(line, i + 1, j - i - 1)
                  exit
                }
                j = i
                while (j <= n && substr(line, j, 1) !~ /[,}]/) j++
                value = substr(line, i, j - i)
                gsub(/^[ \t]+|[ \t]+$/, "", value)
                if (value == "null") value = ""
                print value
                exit
              }
              continue
            }
            if (c == "{") depth++
            else if (c == "}") depth--
            i++
          }
        }'
      ;;
  esac
}

# Locate the aven executable. AVEN_BIN overrides the lookup.
find_aven() {
  if [ -n "${AVEN_BIN:-}" ]; then
    if [ -x "$AVEN_BIN" ] || command -v "$AVEN_BIN" >/dev/null 2>&1; then
      printf '%s' "$AVEN_BIN"
      return 0
    fi
    return 1
  fi
  if command -v aven >/dev/null 2>&1; then
    command -v aven
    return 0
  fi
  for candidate in "$HOME/.local/bin/aven" "/usr/local/bin/aven" "$HOME/.cargo/bin/aven"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# aven_project_for_dir <aven> <dir>
aven_project_for_dir() {
  aven=$1
  dir=$2
  out=$(cd "$dir" 2>/dev/null && "$aven" prime --json 2>/dev/null) || return 0
  json_field "$out" project
}

wait_for_key() {
  if [ -t 0 ]; then
    printf '\nPress Enter to close.'
    read -r _ || true
  fi
}
