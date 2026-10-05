// ==========================================================================
// butfree.online - Interactive Controller
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Mobile Nav Toggle
  const mobileToggle = document.getElementById('mobile-toggle');
  const navLinks = document.getElementById('nav-links');

  if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
      const isOpen = navLinks.classList.contains('open');
      mobileToggle.setAttribute('aria-expanded', isOpen);
    });
  }

  // Pillar Media Tabs Switcher
  const tabButtons = document.querySelectorAll('.pillar-tab-btn');
  const tabPanes = document.querySelectorAll('.pillar-tab-pane');
  const previewSidebarItems = document.querySelectorAll('.preview-menu-item');

  function activatePillar(pillarId) {
    // Update main tabs
    tabButtons.forEach(btn => {
      if (btn.dataset.pillar === pillarId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update panes
    tabPanes.forEach(pane => {
      if (pane.id === `pane-${pillarId}`) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // Sync preview sidebar if present
    previewSidebarItems.forEach(item => {
      if (item.dataset.pillar === pillarId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const pillar = btn.dataset.pillar;
      activatePillar(pillar);
    });
  });

  previewSidebarItems.forEach(item => {
    item.addEventListener('click', () => {
      const pillar = item.dataset.pillar;
      activatePillar(pillar);
      const targetSection = document.getElementById('ecosystem');
      if (targetSection) {
        targetSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // FAQ Accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    questionBtn.addEventListener('click', () => {
      const isActive = item.classList.contains('active');
      
      // Close all other items
      faqItems.forEach(otherItem => {
        otherItem.classList.remove('active');
        otherItem.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
      });

      if (!isActive) {
        item.classList.add('active');
        questionBtn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Google OAuth Preview Modal
  const connectButtons = document.querySelectorAll('.open-oauth-modal');
  const oauthModal = document.getElementById('oauth-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalStep1 = document.getElementById('oauth-step-1');
  const modalStep2 = document.getElementById('oauth-step-2');
  const simulateConnectBtn = document.getElementById('simulate-connect-btn');
  const resetDemoBtn = document.getElementById('reset-demo-btn');

  function openModal() {
    if (oauthModal) {
      oauthModal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal() {
    if (oauthModal) {
      oauthModal.classList.remove('open');
      document.body.style.overflow = '';
      // Reset steps after delay
      setTimeout(() => {
        if (modalStep1 && modalStep2) {
          modalStep1.style.display = 'block';
          modalStep2.style.display = 'none';
        }
      }, 300);
    }
  }

  connectButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  });

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeModal);
  }

  if (oauthModal) {
    oauthModal.addEventListener('click', (e) => {
      if (e.target === oauthModal) {
        closeModal();
      }
    });
  }

  if (simulateConnectBtn) {
    simulateConnectBtn.addEventListener('click', () => {
      simulateConnectBtn.innerHTML = `
        <svg class="animate-spin" style="width: 18px; height: 18px; animation: spin 1s linear infinite;" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" opacity="0.25"></circle>
          <path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        Authorizing Google Drive...
      `;
      simulateConnectBtn.disabled = true;

      setTimeout(() => {
        if (modalStep1 && modalStep2) {
          modalStep1.style.display = 'none';
          modalStep2.style.display = 'block';
        }
        simulateConnectBtn.innerHTML = `Connect Google Drive`;
        simulateConnectBtn.disabled = false;
      }, 1200);
    });
  }

  if (resetDemoBtn) {
    resetDemoBtn.addEventListener('click', () => {
      if (modalStep1 && modalStep2) {
        modalStep1.style.display = 'block';
        modalStep2.style.display = 'none';
      }
    });
  }
});

// Keyframe animation for inline spinner
const style = document.createElement('style');
style.innerHTML = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
