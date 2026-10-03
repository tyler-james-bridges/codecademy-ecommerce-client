export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'We could not complete that request. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}
