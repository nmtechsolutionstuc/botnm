import { requireEnv } from '../config.js';

const API_URL = 'https://api.buffer.com';

async function bufferGraphQL(query, variables = {}) {
  const token = requireEnv('BUFFER_ACCESS_TOKEN');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Buffer API error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

let organizationIdCache = null;
async function getOrganizationId() {
  if (organizationIdCache) return organizationIdCache;
  const data = await bufferGraphQL(`
    query GetOrganizations {
      account { organizations { id } }
    }
  `);
  const orgId = data.account?.organizations?.[0]?.id;
  if (!orgId) throw new Error('No se encontró ninguna organización de Buffer para esta cuenta.');
  organizationIdCache = orgId;
  return orgId;
}

/** Lista los canales (perfiles) conectados, con su id, nombre y red social. */
export async function listChannels() {
  const organizationId = await getOrganizationId();
  const data = await bufferGraphQL(
    `
    query GetChannels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) {
        id
        name
        service
      }
    }
  `,
    { organizationId }
  );
  return data.channels ?? [];
}

/**
 * Crea un posteo (borrador/pendiente si el canal tiene "Requiere aprobación" activado).
 * @param {{ channelId: string, text: string, imageUrls?: string[], dueAt?: string|null }} args
 */
export async function createPost({ channelId, text, imageUrls, dueAt }) {
  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: dueAt ? 'customScheduled' : 'addToQueue',
    ...(dueAt ? { dueAt } : {}),
    assets: (imageUrls ?? []).map((url) => ({ image: { url } })),
  };

  const data = await bufferGraphQL(
    `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id text dueAt }
        }
        ... on MutationError {
          message
        }
      }
    }
  `,
    { input }
  );

  const result = data.createPost;
  if (result.message) {
    throw new Error(`Buffer no pudo crear el posteo: ${result.message}`);
  }
  return result.post;
}
