// Authentication & Session Helper for FREEVEE

export async function fetchCurrentUser() {
  try {
    const res = await fetch('/auth/me');
    if (!res.ok) return { authenticated: false };
    return await res.json();
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}

export function loginWithGoogle() {
  window.location.href = '/auth/google';
}

export async function logoutUser() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.reload();
  } catch (err) {
    console.error('Logout error:', err);
  }
}
