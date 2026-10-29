// Password reveal as an explicit, keyboard-operable choice; the field stays masked by default.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-reveal]').forEach(function (button) {
    var input = document.getElementById(button.getAttribute('data-reveal'));
    if (!input) return;
    button.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'إخفاء' : 'إظهار';
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
      input.focus();
    });
  });
});
