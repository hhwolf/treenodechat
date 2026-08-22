// FALLBACK: the bundled Pretext vendor is unavailable, so the prototype loads
// the official package through esm.sh. Native flow remains intact if offline.
async function wirePretext() {
  try {
    const { prepare, layout } = await import('https://esm.sh/@chenglou/pretext@0.0.8');
    await document.fonts.ready;

    const prepared = new Map();
    const elements = [...document.querySelectorAll('[data-pretext]')];

    const prepareElement = (element) => {
      const style = getComputedStyle(element);
      prepared.set(element, prepare(element.textContent, style.font));
    };

    const relayout = () => {
      prepared.forEach((handle, element) => {
        const style = getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const result = layout(handle, element.clientWidth, lineHeight);
        element.style.minHeight = `${Math.ceil(result.height)}px`;
      });
    };

    elements.forEach((element) => {
      prepareElement(element);
      new MutationObserver(() => {
        prepareElement(element);
        relayout();
      }).observe(element, { characterData: true, childList: true, subtree: true });
    });

    new ResizeObserver(relayout).observe(document.querySelector('.document-split'));
    relayout();
  } catch {
    document.documentElement.dataset.pretext = 'native-fallback';
  }
}

wirePretext();
