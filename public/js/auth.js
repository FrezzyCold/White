document.addEventListener('DOMContentLoaded', () => {
  const refreshButtons = document.querySelectorAll('[data-refresh-captcha]');

  const refresh = (btn) => {
    const wrapper = btn.closest('.captcha-box');
    const img = wrapper ? wrapper.querySelector('.captcha-img') : document.querySelector('.captcha-img');
    if (img) {
      img.src = `/captcha?ts=${Date.now()}`;
    }
  };

  refreshButtons.forEach((btn) => {
    btn.addEventListener('click', () => refresh(btn));
  });

  // Автообновление капчи при загрузке страницы
  const img = document.querySelector('.captcha-img');
  if (img) {
    img.src = `/captcha?ts=${Date.now()}`;
  }
});
