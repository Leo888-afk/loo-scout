/* Loo Scout frontend — vanilla JS SPA, Leaflet map, no trackers. */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var topnav = document.getElementById('topnav');
  var state = { user: null, pos: null, map: null, addMap: null, addLatLng: null, markers: [] };

  var DEFAULT_CENTER = [46.3941, -63.7920]; // Summerside, PE — initial view only

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/api' + path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function stars(n) {
    if (n === null || n === undefined) return '<span class="stars muted">no ratings</span>';
    var full = Math.round(n);
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= full ? '★' : '<span class="off">★</span>';
    return '<span class="stars" title="' + n + '/5">' + out + '</span>';
  }

  function fmtDist(km) {
    if (km === null || km === undefined) return '';
    return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km';
  }

  function pinColor(w) {
    if (!w.ratingCount) return 'gray';
    if (w.avgCleanliness >= 4) return 'green';
    if (w.avgCleanliness >= 3) return 'yellow';
    return 'red';
  }

  function directionsUrl(w) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(w.latitude + ',' + w.longitude);
  }

  function setNav() {
    var u = state.user;
    var html = '';
    if (u) {
      html += '<span>Hi, ' + esc(u.displayName) + '</span>';
      if (u.isAdmin) html += '<a href="#/admin">Moderation</a>';
      html += '<button id="logoutBtn">Log out</button>';
    } else {
      html += '<a href="#/login">Log in</a><a href="#/register">Sign up</a>';
    }
    topnav.innerHTML = html;
    var lb = document.getElementById('logoutBtn');
    if (lb) lb.onclick = function () {
      api('POST', '/auth/logout').then(function () {
        state.user = null;
        setNav();
        location.hash = '#/';
      });
    };
    document.querySelectorAll('#bottomnav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === currentTab());
    });
  }

  function currentTab() {
    var h = location.hash || '#/';
    if (h.indexOf('#/list') === 0) return 'list';
    if (h.indexOf('#/add') === 0) return 'add';
    if (h.indexOf('#/account') === 0 || h.indexOf('#/login') === 0 || h.indexOf('#/register') === 0) return 'account';
    return 'map';
  }

  function getPos() {
    if (state.pos) return Promise.resolve(state.pos);
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { state.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(state.pos); },
        function () { resolve(null); },
        { timeout: 8000, maximumAge: 300000 }
      );
    });
  }

  // ---------------- Map view ----------------
  function viewMap() {
    view.innerHTML =
      '<div class="mapwrap"><div id="map"></div>' +
      '<button class="mapbtn" id="findme">📍 Near me</button></div>' +
      '<p class="muted small" style="margin-top:8px">Tap a pin for details. ' +
      'Green = clean (4+), yellow = okay (3+), red = rough, gray = unrated.</p>';
    var map = L.map('map').setView(DEFAULT_CENTER, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    state.map = map;
    loadMarkers(map, null);

    document.getElementById('findme').onclick = function () {
      getPos().then(function (pos) {
        if (pos) {
          map.setView([pos.lat, pos.lng], 14);
          loadMarkers(map, pos);
        } else {
          alert('Could not get your location.');
        }
      });
    };
    getPos().then(function (pos) {
      if (pos && state.map === map) {
        map.setView([pos.lat, pos.lng], 14);
        loadMarkers(map, pos);
      }
    });
  }

  function loadMarkers(map, pos) {
    var params = new URLSearchParams({ limit: 200 });
    if (pos) { params.set('lat', pos.lat); params.set('lng', pos.lng); }
    api('GET', '/washrooms?' + params.toString()).then(function (list) {
      state.markers.forEach(function (m) { map.removeLayer(m); });
      state.markers = [];
      if (!list.length) {
        L.popup()
          .setLatLng(map.getCenter())
          .setContent('No washrooms here yet.<br><a href="#/add">Add the first one</a> 🚻')
          .openOn(map);
        return;
      }
      list.forEach(function (w) {
        var icon = L.divIcon({
          className: '',
          html: '<div class="pin ' + pinColor(w) + '"></div>',
          iconSize: [30, 30],
          iconAnchor: [15, 28],
          popupAnchor: [0, -26],
        });
        var m = L.marker([w.latitude, w.longitude], { icon: icon }).addTo(map);
        m.bindPopup(
          '<strong>' + esc(w.name) + '</strong><br>' +
          stars(w.avgCleanliness) +
          (w.distanceKm !== undefined && w.distanceKm !== null ? '<br>' + esc(fmtDist(w.distanceKm)) + ' away' : '') +
          '<br><a href="#/w/' + w.id + '">Details &amp; ratings →</a>'
        );
        state.markers.push(m);
      });
    }).catch(function (e) { view.insertAdjacentHTML('beforeend', '<div class="alert">' + esc(e.message) + '</div>'); });
  }

  // ---------------- List view ----------------
  var listFilters = { q: '', wheelchair: false, baby: false, sort: 'distance' };

  function viewList() {
    view.innerHTML =
      '<div class="toolbar">' +
      '<input type="text" id="q" placeholder="Search by name…" value="' + esc(listFilters.q) + '">' +
      '<button class="chip' + (listFilters.wheelchair ? ' on' : '') + '" id="fWc">♿ Accessible</button>' +
      '<button class="chip' + (listFilters.baby ? ' on' : '') + '" id="fBaby">👶 Change table</button>' +
      '<select id="sort" style="width:auto;margin:0">' +
      '<option value="distance"' + (listFilters.sort === 'distance' ? ' selected' : '') + '>Nearest first</option>' +
      '<option value="rating"' + (listFilters.sort === 'rating' ? ' selected' : '') + '>Top rated</option>' +
      '</select></div>' +
      '<div id="results"></div>';

    var qEl = document.getElementById('q');
    var deb;
    qEl.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(function () { listFilters.q = qEl.value; renderList(); }, 350);
    });
    document.getElementById('fWc').onclick = function () { listFilters.wheelchair = !listFilters.wheelchair; viewList(); };
    document.getElementById('fBaby').onclick = function () { listFilters.baby = !listFilters.baby; viewList(); };
    document.getElementById('sort').onchange = function (e) { listFilters.sort = e.target.value; renderList(); };
    renderList();
  }

  function renderList() {
    var box = document.getElementById('results');
    box.innerHTML = '<p class="muted">Loading…</p>';
    getPos().then(function (pos) {
      var params = new URLSearchParams({ limit: 200, sort: listFilters.sort });
      if (listFilters.q) params.set('q', listFilters.q);
      if (listFilters.wheelchair) params.set('wheelchair', '1');
      if (listFilters.baby) params.set('baby', '1');
      if (pos && listFilters.sort === 'distance') { params.set('lat', pos.lat); params.set('lng', pos.lng); }
      return api('GET', '/washrooms?' + params.toString());
    }).then(function (list) {
      if (!list.length) {
        box.innerHTML =
          '<div class="empty"><div class="big">🚻</div>' +
          '<h3>Nothing here yet</h3><p>No washrooms match. Be the first to add one!</p>' +
          '<a class="btn" href="#/add">Add a washroom</a></div>';
        return;
      }
      box.innerHTML = list.map(function (w) {
        return '<a class="card wc-item" href="#/w/' + w.id + '">' +
          '<h3>' + esc(w.name) + '</h3>' +
          '<div class="wc-meta">' + stars(w.avgCleanliness) +
          '<span>' + w.ratingCount + ' rating' + (w.ratingCount === 1 ? '' : 's') + '</span>' +
          (w.distanceKm !== undefined && w.distanceKm !== null ? '<span>📍 ' + esc(fmtDist(w.distanceKm)) + '</span>' : '') +
          (w.wheelchairAccessible ? '<span>♿</span>' : '') +
          (w.babyChangeTable ? '<span>👶</span>' : '') +
          '</div></a>';
      }).join('');
    }).catch(function (e) { box.innerHTML = '<div class="alert">' + esc(e.message) + '</div>'; });
  }

  // ---------------- Detail view ----------------
  function viewDetail(id) {
    view.innerHTML = '<p class="muted">Loading…</p>';
    getPos().then(function (pos) {
      var params = new URLSearchParams();
      if (pos) { params.set('lat', pos.lat); params.set('lng', pos.lng); }
      return api('GET', '/washrooms/' + id + '?' + params.toString());
    }).then(function (w) {
      var html =
        '<div class="card"><h2>' + esc(w.name) + '</h2>' +
        '<div class="wc-meta">' +
        (w.distanceKm !== null ? '<span>📍 ' + esc(fmtDist(w.distanceKm)) + ' away</span>' : '') +
        (w.wheelchairAccessible ? '<span class="badge">♿ Wheelchair accessible</span>' : '') +
        (w.babyChangeTable ? '<span class="badge">👶 Baby change table</span>' : '') +
        '</div>' +
        (w.notes ? '<p>' + esc(w.notes) + '</p>' : '') +
        '<div class="statgrid">' +
        '<div class="stat"><div class="v">' + (w.avgCleanliness === null ? '–' : w.avgCleanliness) + '</div><div class="l">Cleanliness</div>' + stars(w.avgCleanliness) + '</div>' +
        '<div class="stat"><div class="v">' + (w.avgPrivacy === null ? '–' : w.avgPrivacy) + '</div><div class="l">Privacy</div>' + stars(w.avgPrivacy) + '</div>' +
        '<div class="stat"><div class="v">' + (w.avgStalls === null ? '–' : w.avgStalls) + '</div><div class="l">Stalls (avg)</div></div>' +
        '<div class="stat"><div class="v">' + (w.avgUrinals === null ? '–' : w.avgUrinals) + '</div><div class="l">Urinals (avg)</div></div>' +
        '</div>' +
        '<a class="btn block" target="_blank" rel="noopener" href="' + esc(directionsUrl(w)) + '">🧭 Get directions</a>' +
        '<details class="reportbox"><summary>Report this washroom</summary>' +
        '<input type="text" id="repReason" placeholder="What\u2019s wrong?">' +
        '<button class="btn secondary smallbtn" id="repBtn">Send report</button></details>' +
        '</div>';

      html += '<div class="card"><h3>Your rating</h3><div id="ownRating"></div></div>';
      html += '<div class="card"><h3>All ratings (' + w.ratings.length + ')</h3><div id="allRatings">';
      if (!w.ratings.length) {
        html += '<p class="muted">No ratings yet — share the first one below.</p>';
      } else {
        html += w.ratings.map(function (r) {
          return '<div class="rating-row"><div class="rating-head"><strong>' + esc(r.displayName) + '</strong>' +
            '<span class="muted small">' + esc(r.updatedAt.slice(0, 10)) + '</span></div>' +
            '<div class="small">🧼 ' + stars(r.cleanliness) + ' &nbsp; 🔒 ' + stars(r.privacy) + '</div>' +
            '<div class="small muted">' + r.stalls + ' stalls · ' + r.urinals + ' urinals</div>' +
            (r.comment ? '<p>' + esc(r.comment) + '</p>' : '') +
            '<button class="linklike" data-report-rating="' + r.id + '">Report</button></div>';
        }).join('');
      }
      html += '</div></div>';

      view.innerHTML = html;
      renderOwnRating(w);
      wireReports(w);
    }).catch(function (e) { view.innerHTML = '<div class="alert">' + esc(e.message) + '</div>'; });
  }

  function ratingFormHtml(existing) {
    function sel(id, label, min, max, val) {
      var opts = '';
      for (var i = min; i <= max; i++) {
        opts += '<option value="' + i + '"' + (val === i ? ' selected' : '') + '>' + i + '</option>';
      }
      return '<label>' + label + '<select id="' + id + '">' + opts + '</select></label>';
    }
    return (
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      sel('fClean', '🧼 Cleanliness (1-5)', 1, 5, existing ? existing.cleanliness : 4) +
      sel('fPriv', '🔒 Privacy (1-5)', 1, 5, existing ? existing.privacy : 3) +
      sel('fStalls', '🚻 Stalls', 0, 20, existing ? existing.stalls : 2) +
      sel('fUrinals', '🚹 Urinals', 0, 20, existing ? existing.urinals : 1) +
      '</div>' +
      '<label>Comment (optional)<textarea id="fComment" maxlength="1000" placeholder="How was it?">' +
      (existing ? esc(existing.comment) : '') + '</textarea></label>' +
      '<button class="btn block" id="saveRating">' + (existing ? 'Update my rating' : 'Submit rating') + '</button>' +
      (existing ? '<button class="btn secondary block" id="delRating" style="margin-top:8px">Delete my rating</button>' : '')
    );
  }

  function renderOwnRating(w) {
    var box = document.getElementById('ownRating');
    if (!state.user) {
      box.innerHTML = '<p class="muted">Please <a href="#/login">log in</a> to rate this washroom.</p>';
      return;
    }
    box.innerHTML = ratingFormHtml(w.ownRating);
    document.getElementById('saveRating').onclick = function () {
      var body = {
        cleanliness: parseInt(document.getElementById('fClean').value, 10),
        privacy: parseInt(document.getElementById('fPriv').value, 10),
        stalls: parseInt(document.getElementById('fStalls').value, 10),
        urinals: parseInt(document.getElementById('fUrinals').value, 10),
        comment: document.getElementById('fComment').value,
      };
      api('POST', '/washrooms/' + w.id + '/ratings', body)
        .then(function () { route(); })
        .catch(function (e) { alert(e.message); });
    };
    var del = document.getElementById('delRating');
    if (del) del.onclick = function () {
      if (!confirm('Delete your rating?')) return;
      api('DELETE', '/washrooms/' + w.id + '/ratings').then(function () { route(); }).catch(function (e) { alert(e.message); });
    };
  }

  function wireReports(w) {
    var rb = document.getElementById('repBtn');
    if (rb) rb.onclick = function () {
      if (!state.user) { alert('Please log in to report.'); location.hash = '#/login'; return; }
      var reason = document.getElementById('repReason').value.trim();
      if (!reason) { alert('Please say what\u2019s wrong.'); return; }
      api('POST', '/reports', { targetType: 'washroom', targetId: w.id, reason: reason })
        .then(function () { alert('Thanks — the report was sent to moderators.'); })
        .catch(function (e) { alert(e.message); });
    };
    document.querySelectorAll('[data-report-rating]').forEach(function (btn) {
      btn.onclick = function () {
        if (!state.user) { alert('Please log in to report.'); location.hash = '#/login'; return; }
        var reason = prompt('What\u2019s wrong with this rating?');
        if (!reason || !reason.trim()) return;
        api('POST', '/reports', { targetType: 'rating', targetId: parseInt(btn.getAttribute('data-report-rating'), 10), reason: reason.trim() })
          .then(function () { alert('Thanks — the report was sent to moderators.'); })
          .catch(function (e) { alert(e.message); });
      };
    });
  }

  // ---------------- Add view ----------------
  function viewAdd() {
    if (!state.user) {
      view.innerHTML = '<div class="card"><h2>Add a washroom</h2>' +
        '<p>Please <a href="#/login">log in</a> or <a href="#/register">sign up</a> to add a washroom.</p></div>';
      return;
    }
    view.innerHTML =
      '<div class="card"><h2>Add a washroom</h2>' +
      '<label>Name<input type="text" id="aName" placeholder="e.g. Confederation Centre lobby" maxlength="120"></label>' +
      '<label class="checkrow"><input type="checkbox" id="aWc"> ♿ Wheelchair accessible</label>' +
      '<label class="checkrow"><input type="checkbox" id="aBaby"> 👶 Baby change table</label>' +
      '<label>Notes<textarea id="aNotes" maxlength="2000" placeholder="Hours, how to find it, code needed…"></textarea></label>' +
      '<p class="small muted">Location: <strong id="aCoords">not set</strong></p>' +
      '<div class="toolbar"><button class="btn secondary smallbtn" id="aLocate">📍 Use my location</button></div>' +
      '<div class="mapwrap"><div id="addmap"></div></div>' +
      '<p class="small muted">…or tap the map to drop the pin.</p>' +
      '<button class="btn block" id="aSave">Add washroom</button></div>';

    var map = L.map('addmap').setView(DEFAULT_CENTER, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    state.addMap = map;
    state.addLatLng = null;
    var marker = null;
    function setPin(latlng) {
      state.addLatLng = latlng;
      if (marker) map.removeLayer(marker);
      marker = L.marker(latlng).addTo(map);
      document.getElementById('aCoords').textContent =
        latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
    }
    map.on('click', function (e) { setPin(e.latlng); });
    document.getElementById('aLocate').onclick = function () {
      getPos().then(function (pos) {
        if (pos) { map.setView([pos.lat, pos.lng], 16); setPin({ lat: pos.lat, lng: pos.lng }); }
        else alert('Could not get your location.');
      });
    };
    getPos().then(function (pos) { if (pos && state.addMap === map) map.setView([pos.lat, pos.lng], 14); });

    document.getElementById('aSave').onclick = function () {
      var name = document.getElementById('aName').value.trim();
      if (!name) { alert('Please give the washroom a name.'); return; }
      if (!state.addLatLng) { alert('Please set a location — tap the map or use your location.'); return; }
      api('POST', '/washrooms', {
        name: name,
        latitude: state.addLatLng.lat,
        longitude: state.addLatLng.lng,
        notes: document.getElementById('aNotes').value,
        wheelchairAccessible: document.getElementById('aWc').checked,
        babyChangeTable: document.getElementById('aBaby').checked,
      }).then(function (r) { location.hash = '#/w/' + r.id; })
        .catch(function (e) { alert(e.message); });
    };
  }

  // ---------------- Auth views ----------------
  function viewLogin() {
    view.innerHTML =
      '<div class="card"><h2>Log in</h2>' +
      '<label>Email<input type="email" id="lEmail" autocomplete="email"></label>' +
      '<label>Password<input type="password" id="lPass" autocomplete="current-password"></label>' +
      '<button class="btn block" id="lGo">Log in</button>' +
      '<p class="small">No account? <a href="#/register">Sign up</a></p></div>';
    document.getElementById('lGo').onclick = function () {
      api('POST', '/auth/login', {
        email: document.getElementById('lEmail').value,
        password: document.getElementById('lPass').value,
      }).then(function (u) { state.user = u; setNav(); location.hash = '#/'; })
        .catch(function (e) { alert(e.message); });
    };
  }

  function viewRegister() {
    view.innerHTML =
      '<div class="card"><h2>Sign up</h2>' +
      '<label>Display name<input type="text" id="rName" maxlength="40" autocomplete="nickname"></label>' +
      '<label>Email<input type="email" id="rEmail" autocomplete="email"></label>' +
      '<label>Password (min 8 chars)<input type="password" id="rPass" autocomplete="new-password"></label>' +
      '<button class="btn block" id="rGo">Create account</button>' +
      '<p class="small">Have an account? <a href="#/login">Log in</a></p></div>';
    document.getElementById('rGo').onclick = function () {
      api('POST', '/auth/register', {
        displayName: document.getElementById('rName').value,
        email: document.getElementById('rEmail').value,
        password: document.getElementById('rPass').value,
      }).then(function (u) { state.user = u; setNav(); location.hash = '#/'; })
        .catch(function (e) { alert(e.message); });
    };
  }

  function viewAccount() {
    if (!state.user) { location.hash = '#/login'; return; }
    view.innerHTML =
      '<div class="card"><h2>Account</h2>' +
      '<p><strong>' + esc(state.user.displayName) + '</strong><br>' +
      '<span class="muted small">' + esc(state.user.email) + '</span>' +
      (state.user.isAdmin ? ' <span class="badge warn">admin</span>' : '') + '</p>' +
      '<button class="btn secondary block" id="accLogout">Log out</button></div>';
    document.getElementById('accLogout').onclick = function () {
      api('POST', '/auth/logout').then(function () { state.user = null; setNav(); location.hash = '#/'; });
    };
  }

  // ---------------- Admin view ----------------
  function viewAdmin() {
    if (!state.user || !state.user.isAdmin) {
      view.innerHTML = '<div class="alert">Admins only.</div>';
      return;
    }
    view.innerHTML = '<div class="card"><h2>🚨 Reports</h2><div id="admReports"><p class="muted">Loading…</p></div></div>' +
      '<div class="card"><h2>🚩 Flagged washrooms</h2><div id="admFlagged"><p class="muted">Loading…</p></div></div>';
    loadReports();
    api('GET', '/admin/washrooms?status=flagged').then(function (list) {
      var box = document.getElementById('admFlagged');
      if (!list.length) { box.innerHTML = '<p class="muted">None flagged. 🎉</p>'; return; }
      box.innerHTML = list.map(function (w) {
        return '<div class="rating-row"><strong>' + esc(w.name) + '</strong>' +
          '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn smallbtn" data-approve="' + w.id + '">Approve</button>' +
          '<button class="btn danger smallbtn" data-delw="' + w.id + '">Delete</button></div></div>';
      }).join('');
      wireAdmin(box);
    });
  }

  function loadReports() {
    api('GET', '/admin/reports').then(function (rows) {
      var box = document.getElementById('admReports');
      if (!box) return;
      if (!rows.length) { box.innerHTML = '<p class="muted">No open reports. 🎉</p>'; return; }
      box.innerHTML = '<table class="admin"><tr><th>Target</th><th>Reason</th><th>Reporter</th><th></th></tr>' +
        rows.map(function (r) {
          return '<tr><td><strong>' + esc(r.target_type) + '</strong><br>' + esc(r.target_summary || ('#' + r.target_id)) +
            '<br><span class="muted">' + esc(r.created_at.slice(0, 16).replace('T', ' ')) + '</span></td>' +
            '<td>' + esc(r.reason) + '</td><td>' + esc(r.reporter_name) + '</td>' +
            '<td><button class="btn secondary smallbtn" data-resolve="' + r.id + '">Resolve</button><br><br>' +
            (r.target_type === 'washroom'
              ? '<button class="btn smallbtn" data-hidew="' + r.target_id + '">Hide washroom</button>'
              : '<button class="btn danger smallbtn" data-delr="' + r.target_id + '">Delete rating</button>') +
            '</td></tr>';
        }).join('') + '</table>';
      wireAdmin(box);
    }).catch(function (e) {
      var box = document.getElementById('admReports');
      if (box) box.innerHTML = '<div class="alert">' + esc(e.message) + '</div>';
    });
  }

  function wireAdmin(scope) {
    scope.querySelectorAll('[data-resolve]').forEach(function (b) {
      b.onclick = function () {
        api('POST', '/admin/reports/' + b.getAttribute('data-resolve') + '/resolve', {})
          .then(loadReports).catch(function (e) { alert(e.message); });
      };
    });
    scope.querySelectorAll('[data-hidew]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Hide this washroom from everyone?')) return;
        api('POST', '/admin/washrooms/' + b.getAttribute('data-hidew') + '/status', { status: 'flagged' })
          .then(function () { loadReports(); viewAdmin(); }).catch(function (e) { alert(e.message); });
      };
    });
    scope.querySelectorAll('[data-delr]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Delete this rating permanently?')) return;
        api('DELETE', '/admin/ratings/' + b.getAttribute('data-delr'))
          .then(loadReports).catch(function (e) { alert(e.message); });
      };
    });
    scope.querySelectorAll('[data-approve]').forEach(function (b) {
      b.onclick = function () {
        api('POST', '/admin/washrooms/' + b.getAttribute('data-approve') + '/status', { status: 'approved' })
          .then(viewAdmin).catch(function (e) { alert(e.message); });
      };
    });
    scope.querySelectorAll('[data-delw]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Delete this washroom and all its ratings permanently?')) return;
        api('DELETE', '/admin/washrooms/' + b.getAttribute('data-delw'))
          .then(viewAdmin).catch(function (e) { alert(e.message); });
      };
    });
  }

  // ---------------- Router ----------------
  function cleanupMaps() {
    if (state.map) { state.map.remove(); state.map = null; }
    if (state.addMap) { state.addMap.remove(); state.addMap = null; }
    state.markers = [];
  }

  function route() {
    cleanupMaps();
    setNav();
    var h = location.hash || '#/';
    var m;
    if (h === '#/' || h === '#/map') return viewMap();
    if (h === '#/list') return viewList();
    if (h === '#/add') return viewAdd();
    if (h === '#/login') return viewLogin();
    if (h === '#/register') return viewRegister();
    if (h === '#/account') return viewAccount();
    if (h === '#/admin') return viewAdmin();
    if ((m = h.match(/^#\/w\/(\d+)$/))) return viewDetail(parseInt(m[1], 10));
    viewMap();
  }

  window.addEventListener('hashchange', route);

  api('GET', '/auth/me')
    .then(function (r) { state.user = r.user; })
    .catch(function () { state.user = null; })
    .then(function () { setNav(); route(); });
})();
