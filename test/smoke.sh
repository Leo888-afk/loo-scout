#!/usr/bin/env bash
# Smoke test for Loo Scout API. Starts the server, exercises the main
# endpoints with curl, and reports pass/fail. Requires: curl, python3, node.
set -u
cd "$(dirname "$0")/.."

PORT=3210
DB=/tmp/looscout-smoke.db
BASE="http://127.0.0.1:$PORT"
JAR_USER=/tmp/looscout-user.jar
JAR_ADMIN=/tmp/looscout-admin.jar
PASS=0; FAIL=0

cleanup() { kill "$SRV" 2>/dev/null; rm -f "$DB" "$JAR_USER" "$JAR_ADMIN"; }
trap cleanup EXIT

rm -f "$DB" "$JAR_USER" "$JAR_ADMIN"
PORT=$PORT DB_PATH=$DB SESSION_SECRET=test-secret-123 ADMIN_EMAIL=admin@example.com \
  node src/server.js >/tmp/looscout-smoke.log 2>&1 &
SRV=$!

for i in $(seq 1 50); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "$BASE/api/health" >/dev/null || { echo "FAIL: server did not start"; cat /tmp/looscout-smoke.log; exit 1; }

jget()  { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   - $1";
  else FAIL=$((FAIL+1)); echo "FAIL - $1 (expected '$2', got '$3')"; fi
}

# --- register admin + user ---
ADMIN_JSON=$(curl -s -c "$JAR_ADMIN" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"displayName":"Leo","email":"admin@example.com","password":"supersecret1"}')
check "admin register isAdmin" "True" "$(echo "$ADMIN_JSON" | jget "['isAdmin']")"

DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"displayName":"Leo2","email":"admin@example.com","password":"supersecret1"}')
check "duplicate email -> 409" "409" "$DUP"

SHORT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"displayName":"X","email":"x@example.com","password":"short"}')
check "short password -> 400" "400" "$SHORT"

USER_JSON=$(curl -s -c "$JAR_USER" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"displayName":"Sam","email":"sam@example.com","password":"anothersecret1"}')
check "user register isAdmin" "False" "$(echo "$USER_JSON" | jget "['isAdmin']")"

# --- auth checks ---
UNAUTH_W=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/washrooms" -H 'Content-Type: application/json' \
  -d '{"name":"Nope","latitude":1,"longitude":1}')
check "unauth add washroom -> 401" "401" "$UNAUTH_W"

BADLOGIN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"sam@example.com","password":"wrongpassword"}')
check "bad login -> 401" "401" "$BADLOGIN"

ME=$(curl -s -b "$JAR_USER" "$BASE/api/auth/me")
check "me returns user" "Sam" "$(echo "$ME" | jget "['user']['displayName']")"

# --- add washroom ---
W_JSON=$(curl -s -b "$JAR_USER" -X POST "$BASE/api/washrooms" -H 'Content-Type: application/json' \
  -d '{"name":"Test Plaza Restrooms","latitude":46.3941,"longitude":-63.792,"notes":"Near the food court","wheelchairAccessible":true,"babyChangeTable":false}')
WID=$(echo "$W_JSON" | jget "['id']")
check "washroom created (id numeric)" "1" "$(echo "$WID" | grep -Eq '^[0-9]+$' && echo 1 || echo 0)"

BADCOORD=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_USER" -X POST "$BASE/api/washrooms" \
  -H 'Content-Type: application/json' -d '{"name":"Bad","latitude":999,"longitude":1}')
check "bad coords -> 400" "400" "$BADCOORD"

# --- list with distance ---
LIST=$(curl -s -b "$JAR_USER" "$BASE/api/washrooms?lat=46.3941&lng=-63.792")
check "list contains washroom" "Test Plaza Restrooms" "$(echo "$LIST" | jget "[0]['name']")"
check "list distance ~0 km" "0.0" "$(echo "$LIST" | python3 -c "import json,sys; print(float(json.load(sys.stdin)[0]['distanceKm']))")"

SEARCH=$(curl -s "$BASE/api/washrooms?q=plaza")
check "search finds it" "1" "$(echo "$SEARCH" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"
SEARCH_MISS=$(curl -s "$BASE/api/washrooms?q=zzzznope")
check "search miss empty" "0" "$(echo "$SEARCH_MISS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"

FILTER=$(curl -s "$BASE/api/washrooms?wheelchair=1")
check "wheelchair filter" "1" "$(echo "$FILTER" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"
FILTER2=$(curl -s "$BASE/api/washrooms?baby=1")
check "baby filter excludes" "0" "$(echo "$FILTER2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"

# --- ratings: create then update (one per user) ---
R1_CODE=$(curl -s -o /tmp/r1.json -w '%{http_code}' -b "$JAR_USER" -X POST "$BASE/api/washrooms/$WID/ratings" \
  -H 'Content-Type: application/json' -d '{"cleanliness":4,"privacy":3,"stalls":6,"urinals":2,"comment":"Pretty clean!"}')
check "first rating -> 201" "201" "$R1_CODE"
R2_CODE=$(curl -s -o /tmp/r2.json -w '%{http_code}' -b "$JAR_USER" -X POST "$BASE/api/washrooms/$WID/ratings" \
  -H 'Content-Type: application/json' -d '{"cleanliness":5,"privacy":4,"stalls":6,"urinals":2,"comment":"Updated: spotless"}')
check "rating update -> 200" "200" "$R2_CODE"
check "update flagged" "True" "$(cat /tmp/r2.json | jget "['updated']")"

DETAIL=$(curl -s -b "$JAR_USER" "$BASE/api/washrooms/$WID?lat=46.3941&lng=-63.792")
check "detail rating count stays 1" "1" "$(echo "$DETAIL" | jget "['ratingCount']")"
check "detail avg cleanliness updated" "5.0" "$(echo "$DETAIL" | python3 -c "import json,sys; print(float(json.load(sys.stdin)['avgCleanliness']))")"
check "detail avg stalls" "6" "$(echo "$DETAIL" | jget "['avgStalls']")"
check "detail own rating present" "5" "$(echo "$DETAIL" | jget "['ownRating']['cleanliness']")"

BADRATE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_USER" -X POST "$BASE/api/washrooms/$WID/ratings" \
  -H 'Content-Type: application/json' -d '{"cleanliness":9,"privacy":3,"stalls":1,"urinals":1}')
check "bad rating value -> 400" "400" "$BADRATE"

# --- reports + admin moderation ---
REP_JSON=$(curl -s -b "$JAR_USER" -X POST "$BASE/api/reports" -H 'Content-Type: application/json' \
  -d '{"targetType":"washroom","targetId":'"$WID"',"reason":"Test report, please ignore"}')
check "report created" "1" "$(echo "$REP_JSON" | jget "['id']" | grep -Eq '^[0-9]+$' && echo 1 || echo 0)"

NONADMIN_REP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_USER" "$BASE/api/admin/reports")
check "non-admin reports -> 403" "403" "$NONADMIN_REP"

REPS=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/reports")
check "admin sees 1 open report" "1" "$(echo "$REPS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"
check "report target summary" "Test Plaza Restrooms" "$(echo "$REPS" | jget "[0]['target_summary']")"
REPID=$(echo "$REPS" | jget "[0]['id']")

curl -s -b "$JAR_ADMIN" -X POST "$BASE/api/admin/reports/$REPID/resolve" -H 'Content-Type: application/json' -d '{}' >/dev/null
REPS2=$(curl -s -b "$JAR_ADMIN" "$BASE/api/admin/reports")
check "report resolved" "0" "$(echo "$REPS2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"

# flag -> hidden from public -> approve -> visible again
curl -s -b "$JAR_ADMIN" -X POST "$BASE/api/admin/washrooms/$WID/status" -H 'Content-Type: application/json' \
  -d '{"status":"flagged"}' >/dev/null
HIDDEN=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/washrooms/$WID")
check "flagged hidden from public -> 404" "404" "$HIDDEN"
curl -s -b "$JAR_ADMIN" -X POST "$BASE/api/admin/washrooms/$WID/status" -H 'Content-Type: application/json' \
  -d '{"status":"approved"}' >/dev/null
VISIBLE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/washrooms/$WID")
check "re-approved visible -> 200" "200" "$VISIBLE"

# delete own rating
curl -s -b "$JAR_USER" -X DELETE "$BASE/api/washrooms/$WID/ratings" >/dev/null
DETAIL2=$(curl -s "$BASE/api/washrooms/$WID")
check "rating deleted, count 0" "0" "$(echo "$DETAIL2" | jget "['ratingCount']")"

# logout
curl -s -b "$JAR_USER" -c "$JAR_USER" -X POST "$BASE/api/auth/logout" >/dev/null
ME2=$(curl -s -b "$JAR_USER" "$BASE/api/auth/me")
check "logged out" "None" "$(echo "$ME2" | jget "['user']")"

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
