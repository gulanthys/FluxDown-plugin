// Encode locally: QuickJS has neither Canvas nor Node Buffer/zlib.
// PNG uses 1-bit grayscale and stored DEFLATE blocks; no network or native tools.
function qrImage(text) {
  if (typeof text !== 'string' || !text || text.length > 2048) throw new Error('无效的登录二维码');
  var encoded = encodeURIComponent(text);
  var utf8 = [];
  for (var i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') {
      utf8.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else utf8.push(encoded.charCodeAt(i));
  }
  var matrix = BilibiliQr.create([{ data: new Uint8Array(utf8), mode: 'byte' }], { errorCorrectionLevel: 'M' }).modules;
  var scale = 4;
  var width = (matrix.size + 8) * scale;
  var stride = Math.ceil(width / 8) + 1;
  var pixels = new Uint8Array(width * stride);
  for (var y = 0; y < width; y++) {
    var my = Math.floor(y / scale) - 4;
    for (var x = 0; x < width; x++) {
      var mx = Math.floor(x / scale) - 4;
      var dark = mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size && matrix.data[my * matrix.size + mx];
      if (!dark) pixels[y * stride + 1 + (x >> 3)] |= 128 >> (x & 7);
    }
  }
  var deflated = [0x78, 0x01];
  for (var offset = 0; offset < pixels.length;) {
    var length = Math.min(65535, pixels.length - offset);
    deflated.push(offset + length === pixels.length ? 1 : 0, length & 255, length >> 8, (~length) & 255, ((~length) >> 8) & 255);
    for (var j = 0; j < length; j++) deflated.push(pixels[offset + j]);
    offset += length;
  }
  var a = 1, b = 0;
  for (var p = 0; p < pixels.length; p++) { a = (a + pixels[p]) % 65521; b = (b + a) % 65521; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  deflated.push.apply(deflated, u32(((b << 16) | a) >>> 0));
  var png = [137, 80, 78, 71, 13, 10, 26, 10];
  function chunk(type, data) {
    var bytes = [];
    for (var t = 0; t < type.length; t++) bytes.push(type.charCodeAt(t));
    for (var d = 0; d < data.length; d++) bytes.push(data[d]);
    var crc = 0xffffffff;
    for (var c = 0; c < bytes.length; c++) {
      crc ^= bytes[c];
      for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    png.push.apply(png, u32(data.length));
    for (var k = 0; k < bytes.length; k++) png.push(bytes[k]);
    png.push.apply(png, u32((crc ^ 0xffffffff) >>> 0));
  }
  chunk('IHDR', u32(width).concat(u32(width), [1, 0, 0, 0, 0]));
  chunk('IDAT', deflated);
  chunk('IEND', []);
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var base64 = '';
  for (var n = 0; n < png.length; n += 3) {
    var value = (png[n] << 16) | ((png[n + 1] || 0) << 8) | (png[n + 2] || 0);
    base64 += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63] +
      (n + 1 < png.length ? alphabet[(value >>> 6) & 63] : '=') +
      (n + 2 < png.length ? alphabet[value & 63] : '=');
  }
  return 'data:image/png;base64,' + base64;
}
