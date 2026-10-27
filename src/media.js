import { normalize } from './supabase.js';

function productMediaDescription(product, knowledge) {
  const productName = normalize(product.name);
  const exactKnowledge = knowledge.find((item) => {
    const title = normalize(item.title);
    return normalize(item.topic) === 'product' && title.includes(productName) && /(caracter|composicao|detalhe|tecnic)/.test(title);
  });
  return (exactKnowledge?.content || '').replace(/(?:Ao responder|Quando responder)[^.?!]*(?:[.?!]|$)/gi, '').replace(/\s+/g, ' ').trim();
}

export function selectProductMedia(product, state, limit = 3) {
  const applicable = (product?.media || []).filter((media) => !media.variant_id || !state.currentVariantId || media.variant_id === state.currentVariantId);
  const unsent = applicable.filter((media) => !state.sentMedia.includes(media.id));
  return (unsent.length > 0 ? unsent : applicable).slice(0, limit);
}

export async function deliverProductMedia({ sessionId, to, product, knowledge, mediaItems, state, send, resolveUrl, persist, pause, onFailure = () => {} }) {
  for (let index = 0; index < mediaItems.length; index += 1) {
    const media = mediaItems[index];
    if (state.delivery.sentMediaIds.includes(media.id)) continue;
    const confirmedDescription = productMediaDescription(product, knowledge);
    const caption = index === 0 && confirmedDescription
      ? `${product.name}: ${confirmedDescription} ${media.media_type === 'video' ? 'Vídeo' : 'Imagem'} de referência; cores, tecidos e configuração precisam ser confirmados.`
      : `${product.name} - ${media.media_type === 'video' ? 'outro vídeo' : 'outra imagem'} de referência do modelo. Cores e tecidos precisam ser confirmados.`;
    try {
      const url = await resolveUrl(media);
      await send(sessionId, to, url, caption, { mediaId: media.id, productId: product.id, mimeType: media.mime_type || null });
    } catch (error) {
      onFailure(error, media);
      throw error;
    }
    state.sentMedia = [...state.sentMedia, media.id].slice(-20);
    state.delivery.sentMediaIds = [...state.delivery.sentMediaIds, media.id].slice(-20);
    await persist(sessionId, state);
    if (index < mediaItems.length - 1) await pause(1200);
  }
}
