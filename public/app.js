'use strict';

function updateType() {
  const checked = document.querySelector('input[name="type"]:checked');
  const doubles = checked && checked.value === 'doubles';
  document.querySelectorAll('.doubles-only').forEach((label) => {
    label.hidden = !doubles;
    const select = label.querySelector('select');
    if (select) {
      select.disabled = !doubles;
      select.required = doubles;
    }
  });
}

function updateDetail() {
  const toggle = document.querySelector('[data-detail-toggle]');
  const box = document.querySelector('[data-score-box]');
  if (!toggle || !box) return;
  box.hidden = !toggle.checked;
  box.querySelectorAll('input').forEach((input) => {
    input.required = toggle.checked;
  });
}

document.querySelectorAll('input[name="type"]').forEach((input) => {
  input.addEventListener('change', updateType);
});

const detailToggle = document.querySelector('[data-detail-toggle]');
if (detailToggle) detailToggle.addEventListener('change', updateDetail);

document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const message = form.getAttribute('data-confirm') || '确定吗？';
    if (!window.confirm(message)) event.preventDefault();
  });
});

/* 审核页：全选与批量提交 */
const checkAll = document.querySelector('[data-check-all]');
if (checkAll) {
  checkAll.addEventListener('change', () => {
    document.querySelectorAll('input[name="ids"]').forEach((box) => {
      box.checked = checkAll.checked;
    });
  });
}

const batchForm = document.getElementById('batchForm');
if (batchForm) {
  batchForm.addEventListener('submit', (event) => {
    const picked = document.querySelectorAll('input[name="ids"]:checked');
    if (!picked.length) {
      event.preventDefault();
      window.alert('先勾选要通过的比赛');
      return;
    }
    if (!window.confirm(`确定通过选中的 ${picked.length} 场比赛吗？`)) event.preventDefault();
  });
}

updateType();
updateDetail();
