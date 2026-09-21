globalThis.resolve = async (ctx) => {
  if (String(ctx.resolverItem || '').indexOf('video:') === 0) return await resolveUploaderVideo(ctx);
  if (ctx.resolverItem) return await resolveEpisode(ctx);
  return await resolveManifest(ctx);
};

globalThis.subscribe = async (ctx) => isUploaderUrl(ctx.url)
  ? await subscribeUploader(ctx)
  : await subscribeBangumi(ctx);
