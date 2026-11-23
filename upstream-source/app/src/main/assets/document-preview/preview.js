'use strict';

async function renderDocument() {
  const response = await fetch('/document');
  if (!response.ok) throw new Error('Document unavailable');
  await docx.renderAsync(await response.arrayBuffer(), document.getElementById('document'), null, {
    ignoreWidth:true,
    ignoreHeight:true,
    renderAltChunks:false
  });
  document.title = 'ready';
}

renderDocument().catch(() => { document.title = 'failed'; });
