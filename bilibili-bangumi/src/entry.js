globalThis.resolve = async (ctx) => {
  if (String(ctx.resolverItem || '').indexOf('video:') === 0) return await resolveUploaderVideo(ctx);
  if (ctx.resolverItem) return await resolveEpisode(ctx);
  ctx = await expandBilibiliShortUrl(ctx);
  if (/^https?:\/\/(?:(?:www|m)\.)?bilibili\.com\/video\//i.test(String(ctx.url || '').trim())) return await resolveVideoPage(ctx);
  return await resolveManifest(ctx);
};

globalThis.subscribe = async (ctx) => {
  ctx = await expandBilibiliShortUrl(ctx);
  return isUploaderUrl(ctx.url) ? await subscribeUploader(ctx) : await subscribeBangumi(ctx);
};
