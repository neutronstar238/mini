'use strict';
document.getElementById('login-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var u = document.getElementById('login-username').value.trim();
  var p = document.getElementById('login-password').value;
  var errEl = document.getElementById('login-err');
  errEl.textContent = '';
  if (!u || !p) { errEl.textContent = '请输入用户名与密码'; return; }
  try {
    var d = await api('/api/contest/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    if (d.user.role !== 'admin') { errEl.textContent = '仅管理员可登录管理端'; return; }
    localStorage.setItem('token', d.token);
    toast('欢迎，管理员');
    location.href = '/admin/overview';
  } catch (err) { errEl.textContent = err.message; }
});
