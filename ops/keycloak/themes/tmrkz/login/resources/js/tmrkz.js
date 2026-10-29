// Sign-in page behaviour: password reveal (masked by default, keyboard operable) and a single submission per click.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-reveal]').forEach(function (button) {
    var input = document.getElementById(button.getAttribute('data-reveal'));
    if (!input) return;
    button.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
      input.focus();
    });
  });
  var form = document.getElementById('kc-form-login');
  var submit = document.getElementById('kc-login');
  if (form && submit) {
    form.addEventListener('submit', function (e) {
      if (submit.disabled) {
        e.preventDefault();
        return;
      }
      submit.disabled = true;
      submit.classList.add('is-loading');
    });
    // Coming back through the browser history must not leave the button stuck.
    window.addEventListener('pageshow', function () {
      submit.disabled = false;
      submit.classList.remove('is-loading');
      var pw = document.getElementById('password');
      if (pw) pw.type = 'password';
    });
  }
});
