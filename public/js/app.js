document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.querySelector('[data-download]');

  const goTo = (url) => {
    window.location.href = url;
  };

  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const authed = downloadBtn.dataset.authed === 'true';
      const url = downloadBtn.dataset.url;

      downloadBtn.classList.add('loading');
      downloadBtn.querySelector('.btn-label').textContent = authed ? 'Готовим загрузку…' : 'Нужно войти';

      setTimeout(() => {
        goTo(url || '/login');
      }, authed ? 350 : 200);
    });
  }

  const flash = document.querySelector('.flash');
  if (flash) {
    setTimeout(() => flash.remove(), 3200);
  }
});
