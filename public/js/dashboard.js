function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const id = 'toast-' + Date.now();
  const bgClass = type === 'success' ? 'bg-success' : 'bg-danger';

  const toastDiv = document.createElement('div');
  toastDiv.id = id;
  toastDiv.className = `toast align-items-center text-white ${bgClass} border-0`;
  toastDiv.setAttribute('role', 'alert');
  toastDiv.innerHTML = `<div class="d-flex"><div class="toast-body"></div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  toastDiv.querySelector('.toast-body').textContent = message;
  container.appendChild(toastDiv);

  const toastEl = document.getElementById(id);
  const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

// Settings form submission
const settingsForm = document.getElementById('settings-form');
if (settingsForm) {
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const guildId = settingsForm.dataset.guildId;
    const formData = new FormData(settingsForm);
    const data = Object.fromEntries(formData.entries());

    // Handle unchecked checkboxes (they are omitted from FormData)
    settingsForm.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!data[cb.name]) {
        data[cb.name] = '';
      }
    });

    try {
      const res = await fetch(`/api/guild/${guildId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (result.success) {
        showToast('Settings saved successfully!');
      } else {
        showToast(result.error || 'Failed to save settings', 'error');
      }
    } catch (err) {
      showToast('Failed to save settings: ' + err.message, 'error');
    }
  });
}

// ===== Exempt Channels =====
async function addExemptChannel(guildId) {
  const select = document.getElementById('add-exempt-channel');
  const channelId = select.value;
  if (!channelId) return;

  const channelName = select.options[select.selectedIndex].text;

  try {
    const res = await fetch(`/api/guild/${guildId}/exempt-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, action: 'add' }),
    });
    const result = await res.json();
    if (result.success) {
      const list = document.getElementById('exempt-channels-list');
      const badge = document.createElement('span');
      badge.className = 'badge bg-secondary d-flex align-items-center gap-1 exempt-badge';
      badge.dataset.channelId = channelId;
      badge.textContent = channelName;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn-close btn-close-white ms-1';
      closeBtn.style.cssText = 'font-size: 0.5rem; width: 0.5em; height: 0.5em;';
      closeBtn.addEventListener('click', () => removeExemptChannel(guildId, channelId, closeBtn));
      badge.appendChild(closeBtn);
      list.appendChild(badge);

      select.querySelector(`option[value="${channelId}"]`).remove();
      select.value = '';

      showToast('Channel exempted!');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function removeExemptChannel(guildId, channelId, btn) {
  try {
    const res = await fetch(`/api/guild/${guildId}/exempt-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, action: 'remove' }),
    });
    const result = await res.json();
    if (result.success) {
      const badge = btn.closest('.exempt-badge');
      const channelName = badge.textContent.trim();
      badge.remove();

      const select = document.getElementById('add-exempt-channel');
      if (select) {
        const option = document.createElement('option');
        option.value = channelId;
        option.textContent = channelName;
        select.appendChild(option);
      }

      showToast('Channel removed from exemptions.');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ===== Image-Only Channels =====
async function addImageOnlyChannel(guildId) {
  const select = document.getElementById('add-image-only-channel');
  const channelId = select.value;
  if (!channelId) return;

  const channelName = select.options[select.selectedIndex].text;

  try {
    const res = await fetch(`/api/guild/${guildId}/image-only-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, action: 'add' }),
    });
    const result = await res.json();
    if (result.success) {
      const list = document.getElementById('image-only-channels-list');
      const badge = document.createElement('span');
      badge.className = 'badge bg-secondary d-flex align-items-center gap-1 py-1 image-only-badge';
      badge.dataset.channelId = channelId;
      badge.textContent = channelName;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn-close btn-close-white ms-1';
      closeBtn.style.cssText = 'font-size: 0.5rem; width: 0.5em; height: 0.5em;';
      closeBtn.addEventListener('click', () => removeImageOnlyChannel(guildId, channelId, closeBtn));
      badge.appendChild(closeBtn);
      list.appendChild(badge);

      select.querySelector(`option[value="${channelId}"]`).remove();
      select.value = '';

      showToast('Image-only channel added!');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function removeImageOnlyChannel(guildId, channelId, btn) {
  try {
    const res = await fetch(`/api/guild/${guildId}/image-only-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, action: 'remove' }),
    });
    const result = await res.json();
    if (result.success) {
      const badge = btn.closest('.image-only-badge');
      const channelName = badge.textContent.trim();
      badge.remove();

      const select = document.getElementById('add-image-only-channel');
      if (select) {
        const option = document.createElement('option');
        option.value = channelId;
        option.textContent = channelName;
        select.appendChild(option);
      }

      showToast('Image-only channel removed.');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ===== Banned Domains =====
async function addBannedDomain(guildId) {
  const input = document.getElementById('banned-domain-input');
  const domain = input.value.trim().toLowerCase();
  if (!domain) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/banned-domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, action: 'add' }),
    });
    const result = await res.json();
    if (result.success) {
      const list = document.getElementById('banned-domains-list');
      const badge = document.createElement('span');
      badge.className = 'badge bg-secondary d-flex align-items-center gap-1 py-1 domain-badge';
      badge.dataset.domain = domain;
      badge.innerHTML = `<i class="bi bi-globe2" style="font-size: 0.7rem;"></i> ${escapeHtml(domain)}`;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn-close btn-close-white ms-1';
      closeBtn.style.cssText = 'font-size: 0.5rem; width: 0.5em; height: 0.5em;';
      closeBtn.addEventListener('click', () => removeBannedDomain(guildId, domain, closeBtn));
      badge.appendChild(closeBtn);
      list.appendChild(badge);

      input.value = '';
      showToast('Domain banned!');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function removeBannedDomain(guildId, domain, btn) {
  try {
    const res = await fetch(`/api/guild/${guildId}/banned-domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, action: 'remove' }),
    });
    const result = await res.json();
    if (result.success) {
      const badge = btn.closest('.domain-badge');
      badge.remove();
      showToast('Domain removed from ban list.');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ===== Utility =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Initialize Bootstrap Popovers =====
document.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => {
  new bootstrap.Popover(el);
});

// ===== Reset Custom Messages =====
document.querySelectorAll('.reset-default').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const target = link.dataset.target;
    const textarea = document.querySelector(`textarea[name="${target}"]`);
    if (textarea) {
      textarea.value = '';
      showToast('Message reset to default. Save to apply.');
    }
  });
});

// ===== Warning Deletion =====
async function deleteWarning(guildId, warningId) {
  if (!confirm('Are you sure you want to delete this warning?')) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/warnings/${warningId}`, {
      method: 'DELETE',
    });
    const result = await res.json();
    if (result.success) {
      const row = document.getElementById(`warning-row-${warningId}`);
      if (row) {
        row.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        row.style.opacity = '0';
        row.style.transform = 'translateX(20px)';
        setTimeout(() => row.remove(), 300);
      }
      showToast('Warning deleted.');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ===== Sidebar Navigation Scroll-Spy =====
(function () {
  const sidebarItems = document.querySelectorAll('.sidebar-nav-item[data-section]');
  if (!sidebarItems.length) return;

  const sections = [];
  sidebarItems.forEach(item => {
    const sectionId = item.dataset.section;
    const sectionEl = document.getElementById(sectionId);
    if (sectionEl) {
      sections.push({ item, el: sectionEl });
    }
  });

  if (!sections.length) return;

  // Click handler for sidebar items
  sidebarItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = item.dataset.section;
      const sectionEl = document.getElementById(sectionId);
      if (sectionEl) {
        const offset = 90;
        const top = sectionEl.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: 'smooth' });

        sectionEl.classList.add('highlight');
        setTimeout(() => sectionEl.classList.remove('highlight'), 1500);
      }
    });
  });

  // Scroll-spy: update active sidebar item based on scroll position
  function updateActiveSidebar() {
    const scrollY = window.scrollY + 120;
    let currentSection = sections[0];

    for (const section of sections) {
      if (section.el.offsetTop <= scrollY) {
        currentSection = section;
      }
    }

    sidebarItems.forEach(i => i.classList.remove('active'));
    if (currentSection) {
      currentSection.item.classList.add('active');
    }
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        updateActiveSidebar();
        ticking = false;
      });
      ticking = true;
    }
  });

  updateActiveSidebar();
})();
