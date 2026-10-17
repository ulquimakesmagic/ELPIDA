export function bindSearch({input,sheet,sheetInput,topForm,sheetForm,mobileButton,document,onSearch}) {
  const send = (value,submit=false) => { for (const field of [input, sheetInput]) if (field && field.value !== value) field.value = value; onSearch(value,{submit}); };
  input?.addEventListener('input', () => send(input.value));
  sheetInput?.addEventListener('input', () => send(sheetInput.value));
  for (const form of [topForm,sheetForm]) form?.addEventListener('submit', event => { event.preventDefault(); send(form===sheetForm?sheetInput?.value??'':input?.value??'',true); if(form===sheetForm) sheet?.close(); });
  mobileButton?.addEventListener('click', () => { if(sheet&&!sheet.open)sheet.showModal(); sheetInput?.focus(); });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    event.preventDefault();
    if (input && input.offsetParent) { input.focus(); input.select(); } else { if(sheet&&!sheet.open)sheet.showModal(); sheetInput?.focus(); }
  });
}
