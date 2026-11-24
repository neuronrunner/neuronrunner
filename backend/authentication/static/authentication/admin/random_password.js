(function () {
  function generatePassword(length) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}';
    var randomValues = new Uint32Array(length);
    window.crypto.getRandomValues(randomValues);

    var password = '';
    for (var i = 0; i < length; i += 1) {
      password += chars[randomValues[i] % chars.length];
    }

    return password;
  }

  function initRandomPasswordButton() {
    var generateButton = document.getElementById('generate-random-password-btn');
    var toggleVisibilityButton = document.getElementById('toggle-password-visibility-btn');
    var password1 = document.getElementById('id_password1');
    var password2 = document.getElementById('id_password2');

    if (!password1 || !password2) {
      return;
    }

    if (generateButton) {
      generateButton.addEventListener('click', function () {
        var password = generatePassword(20);
        password1.value = password;
        password2.value = password;
      });
    }

    if (toggleVisibilityButton) {
      toggleVisibilityButton.addEventListener('click', function () {
        var isHidden = password1.type === 'password';
        var nextType = isHidden ? 'text' : 'password';
        password1.type = nextType;
        password2.type = nextType;
        toggleVisibilityButton.textContent = isHidden ? 'Hide Password' : 'Show Password';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRandomPasswordButton);
  } else {
    initRandomPasswordButton();
  }
})();
