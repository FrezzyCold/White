document.addEventListener('DOMContentLoaded', () => {
  const forms = document.querySelectorAll('[data-upload-form]');

  const handleUpload = (form) => {
    const progress = form.querySelector('[data-progress]');
    const fill = progress ? progress.querySelector('.progress-fill') : null;
    const valueEl = progress ? progress.querySelector('.progress-value') : null;
    const label = progress ? progress.querySelector('.progress-label') : null;
    const submitBtn = form.querySelector('button[type="submit"], button.primary');

    if (!progress || !fill || !valueEl || !label) {
      return;
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();

      progress.hidden = false;
      progress.classList.remove('progress-error');
      fill.style.width = '0%';
      valueEl.textContent = '0%';
      label.textContent = 'Загружаем...';
      if (submitBtn) submitBtn.disabled = true;

      const xhr = new XMLHttpRequest();
      xhr.open('POST', form.action);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        fill.style.width = `${percent}%`;
        valueEl.textContent = `${percent}%`;
        label.textContent = percent >= 100 ? 'Фиксируем...' : 'Загружаем...';
      };

      const handleError = (text) => {
        label.textContent = text;
        progress.classList.add('progress-error');
        if (submitBtn) submitBtn.disabled = false;
      };

      xhr.onerror = () => handleError('Ошибка сети');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 400) {
          fill.style.width = '100%';
          valueEl.textContent = '100%';
          label.textContent = 'Готово, обновляем...';
          setTimeout(() => window.location.reload(), 450);
        } else {
          handleError(`Ошибка ${xhr.status || ''}`.trim());
        }
      };

      xhr.send(new FormData(form));
    });
  };

  forms.forEach(handleUpload);
});
