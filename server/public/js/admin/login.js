'use strict';
document.getElementById('login-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var u = document.getElementById('login-username').value.trim();
  var p = document.getElementById('login-password').value;
  var errEl = document.getElementById('login-err');
  var btn = document.getElementById('login-btn');
  errEl.textContent = '';
  if (!u || !p) { errEl.textContent = '请输入用户名与密码'; return; }
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    var d = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    if (d.user.role !== 'admin') { errEl.textContent = '仅管理员可登录管理端'; return; }
    localStorage.setItem('token', d.token);
    toast('欢迎，管理员');
    location.href = '/admin/overview';
  } catch (err) { errEl.textContent = err.message; }
  finally {
    btn.disabled = false;
    btn.textContent = '进入管理后台';
  }
});
