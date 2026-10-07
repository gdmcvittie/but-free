// ===========================================================================
// butfree.online - Landing page and authenticated app launcher
// ===========================================================================

const AUTH_ORIGIN = 'https://games.butfree.online';

document.addEventListener('DOMContentLoaded', () => {
  const initialAuthStatus = new URLSearchParams(window.location.search).get('auth_status');
  if (initialAuthStatus) {
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  // Mobile navigation
  const mobileToggle = document.getElementById('mobile-toggle');
  const navLinks = document.getElementById('nav-links');
  if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
      mobileToggle.setAttribute('aria-expanded', navLinks.classList.contains('open'));
    });
  }

  // Pillar media tabs
  const tabButtons = document.querySelectorAll('.pillar-tab-btn');
  const tabPanes = document.querySelectorAll('.pillar-tab-pane');
  const previewSidebarItems = document.querySelectorAll('.preview-menu-item');

  function activatePillar(pillarId) {
    tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.pillar === pillarId));
    tabPanes.forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${pillarId}`));
    previewSidebarItems.forEach((item) => item.classList.toggle('active', item.dataset.pillar === pillarId));
  }

  tabButtons.forEach((button) => button.addEventListener('click', () => activatePillar(button.dataset.pillar)));
  previewSidebarItems.forEach((item) => item.addEventListener('click', () => {
    activatePillar(item.dataset.pillar);
    document.getElementById('ecosystem')?.scrollIntoView({ behavior: 'smooth' });
  }));

  // FAQ accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach((item) => {
    const question = item.querySelector('.faq-question');
    question?.addEventListener('click', () => {
      const shouldOpen = !item.classList.contains('active');
      faqItems.forEach((other) => {
        other.classList.remove('active');
        other.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
      });
      if (shouldOpen) {
        item.classList.add('active');
        question.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Public-page calls to action open the real Google OAuth flow.
  const connectButtons = document.querySelectorAll('.open-oauth-modal');
  const oauthModal = document.getElementById('oauth-modal');
  const modalCloseButton = document.getElementById('modal-close-btn');
  const startOAuthButton = document.getElementById('start-google-oauth-btn');

  function openModal() {
    oauthModal?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    oauthModal?.classList.remove('open');
    document.body.style.overflow = '';
  }

  connectButtons.forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    openModal();
  }));
  modalCloseButton?.addEventListener('click', closeModal);
  oauthModal?.addEventListener('click', (event) => {
    if (event.target === oauthModal) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  startOAuthButton?.addEventListener('click', () => {
    startOAuthButton.disabled = true;
    startOAuthButton.textContent = 'Opening Google sign-in...';
    window.location.assign(`${AUTH_ORIGIN}/auth/google/welcome`);
  });

  const launcher = document.getElementById('app-launcher');
  const launcherGrid = document.getElementById('launcher-grid');
  const launcherName = document.getElementById('launcher-name');
  const launcherEmail = document.getElementById('launcher-email');
  const launcherAvatar = document.getElementById('launcher-avatar');
  const signOutButton = document.getElementById('launcher-signout');
  const authNotice = document.getElementById('auth-notice');

  // App destinations are not inserted into the page unless the server confirms
  // a signed Google OAuth session.
  const apps = [
    {
      name: 'ComixoloFree',
      category: 'Comics & Manga',
      url: 'https://comics.butfree.online',
      description: 'Read your cloud comics and manga.',
      icon: '📚',
      color: 'comics'
    },
    {
      name: 'Freevee',
      category: 'TV & Movies',
      url: 'https://tv.butfree.online',
      description: 'Stream your personal movies and TV library.',
      icon: '🎬',
      color: 'video'
    },
    {
      name: 'Fraudio',
      category: 'Music & Audiobooks',
      url: 'https://music.butfree.online',
      description: 'Listen to music and continue your audiobooks.',
      icon: '🎧',
      color: 'music'
    },
    {
      name: 'FREEPLAY',
      category: 'Retro Games',
      url: 'https://games.butfree.online',
      description: 'Browse your cloud game library and play retro favorites.',
      icon: '🕹️',
      color: 'games'
    }
  ];

  function renderAppLinks() {
    if (!launcherGrid) return;
    launcherGrid.replaceChildren();
    apps.forEach((app) => {
      const card = document.createElement('article');
      card.className = 'launcher-app-card';

      const icon = document.createElement('div');
      icon.className = `launcher-app-icon ${app.color}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = app.icon;

      const category = document.createElement('span');
      category.className = 'launcher-app-category';
      category.textContent = app.category;

      const title = document.createElement('h2');
      title.textContent = app.name;

      const description = document.createElement('p');
      description.textContent = app.description;

      const link = document.createElement('a');
      link.className = 'btn btn-primary launcher-app-link';
      link.href = app.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open app ↗';

      card.append(icon, category, title, description, link);
      launcherGrid.appendChild(card);
    });
  }

  function showLauncher(user) {
    document.body.classList.remove('auth-checking');
    document.body.classList.add('is-authenticated');
    launcher?.setAttribute('aria-hidden', 'false');
    if (launcherName) launcherName.textContent = user.name || 'Google account';
    if (launcherEmail) launcherEmail.textContent = user.email || '';
    if (launcherAvatar && user.avatar) {
      launcherAvatar.src = user.avatar;
      launcherAvatar.referrerPolicy = 'no-referrer';
      launcherAvatar.hidden = false;
    }
    renderAppLinks();
  }

  async function checkGoogleSession() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`${AUTH_ORIGIN}/api/welcome/session`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      });
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated && data.user) {
          showLauncher(data.user);
          return;
        }
      }
    } catch (error) {
      console.info('[Welcome] Google session check unavailable:', error.message);
    } finally {
      clearTimeout(timeout);
    }

    document.body.classList.remove('auth-checking');
    if (authNotice && initialAuthStatus === 'error') {
      authNotice.textContent = 'Google sign-in was cancelled or could not be completed. Please try again.';
      authNotice.hidden = false;
    }
  }

  signOutButton?.addEventListener('click', async () => {
    signOutButton.disabled = true;
    signOutButton.textContent = 'Signing out...';
    try {
      await fetch(`${AUTH_ORIGIN}/api/welcome/logout`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store'
      });
    } catch (error) {
      console.warn('[Welcome] Sign-out request failed:', error.message);
    }
    window.location.replace('/');
  });

  checkGoogleSession();
});

const style = document.createElement('style');
style.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
document.head.appendChild(style);
