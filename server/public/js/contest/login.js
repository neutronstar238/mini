'use strict';
document.querySelectorAll('.login-tabs .tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.login-tabs .tab').forEach(function (t) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById('login-form').hidden = tab.dataset.tab !== 'login';
    document.getElementById('register-form').hidden = tab.dataset.tab !== 'register';
  });
});
function setErr(id, msg) { document.getElementById(id).textContent = msg || ''; }
function setBusy(id, busy, busyText) {
  var btn = document.getElementById(id);
  if (!btn.dataset.idleText) btn.dataset.idleText = btn.textContent;
  btn.disabled = busy;
  btn.textContent = busy ? busyText : btn.dataset.idleText;
}

document.getElementById('login-form').addEventListener('submit', async function (e) {
  e.preventDefault(); setErr('login-err');
  var u = document.getElementById('login-username').value.trim();
  var p = document.getElementById('login-password').value;
  if (!u || !p) return setErr('login-err', '请输入用户名与密码');
  setBusy('login-btn', true, '登录中…');
  try {
    var d = await api('/api/contest/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    localStorage.setItem('token', d.token);
    toast('欢迎回来，' + d.user.username);
    location.href = '/contest/contests';
  } catch (err) { setErr('login-err', err.message); }
  finally { setBusy('login-btn', false); }
});

document.getElementById('register-form').addEventListener('submit', async function (e) {
  e.preventDefault(); setErr('reg-err');
  var u = document.getElementById('reg-username').value.trim();
  var n = document.getElementById('reg-nickname').value.trim();
  var p = document.getElementById('reg-password').value;
  if (!u || !p) return setErr('reg-err', '请输入用户名与密码');
  setBusy('reg-btn', true, '注册中…');
  try {
    var d = await api('/api/contest/auth/register', { method: 'POST', body: JSON.stringify({ username: u, password: p, nickname: n }) });
    localStorage.setItem('token', d.token);
    toast('注册成功，已自动登录');
    setTimeout(function () { location.href = '/contest/contests'; }, 600);
  } catch (err) { setErr('reg-err', err.message); }
  finally { setBusy('reg-btn', false); }
});
