// 在浏览器内保留图片，绝不上传或输出二维码内容。
(() => {
  const panel = document.createElement('section');
  panel.style.cssText = 'margin:16px auto;padding:16px;max-width:850px;border:1px solid #777;border-radius:8px;font:14px sans-serif;color:inherit';
  panel.innerHTML = `<h2>本地扫码模拟</h2><p>选择一张或多张二维码图片（按选择顺序消费）。进入应用扫码页，逐次按确认扫描；可随时重新选择或清空。</p><p>图片只在当前页面内存中读取，不上传到预览服务器。扫码后应用会真实连接二维码中指定的 MCP 服务；仅使用可信二维码。保存配置可能写入浏览器本地存储，结束后请清除该站点数据。</p><input type="file" accept="image/*" multiple aria-label="选择二维码图片"> <button type="button">清空图片</button><p role="status"></p>`;
  document.querySelector('main').prepend(panel);
  const input = panel.querySelector('input');
  const status = panel.querySelector('[role=status]');
  let files = [];
  function update() { status.textContent = `待扫描图片：${files.length} 张`; }
  input.addEventListener('change', () => { files = Array.from(input.files); input.value = ''; update(); });
  panel.querySelector('button').addEventListener('click', () => { files = []; input.value = ''; update(); });
  window.__localQrTakePhoto = async () => {
    const file = files.shift();
    update();
    if (!file) throw new Error('请先在本地预览面板选择二维码图片');
    const data = await file.arrayBuffer();
    return { data: new Uint8Array(data), mimeType: file.type || 'image/png' };
  };
  update();
})();
