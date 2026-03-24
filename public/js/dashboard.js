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

// ===== Self Roles =====
async function loadSelfRolePanels(guildId) {
  const container = document.getElementById('selfrole-panels-container');
  if (!container) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/self-role-panels`);
    const result = await res.json();
    if (!result.success) {
      container.innerHTML = '<div class="text-danger">Failed to load panels</div>';
      return;
    }

    if (result.panels.length === 0) {
      container.innerHTML = '<div class="text-muted"><i class="bi bi-info-circle"></i> No self-role panels yet. Create one below.</div>';
      return;
    }

    container.innerHTML = '';
    result.panels.forEach(panel => {
      const card = document.createElement('div');
      card.className = 'card bg-dark border-secondary mb-3';
      card.id = `selfrole-panel-${panel.id}`;

      const rolesList = panel.options.map(opt => {
        const emojiDisplay = opt.emoji ? opt.emoji + ' ' : '';
        const labelDisplay = opt.label || opt.role_name;
        return `<span class="badge bg-secondary d-inline-flex align-items-center gap-1 py-1 me-1 mb-1" data-role-id="${opt.role_id}">
          ${emojiDisplay}<span style="color: ${escapeHtml(opt.role_color)}">${escapeHtml(labelDisplay)}</span>
          <button type="button" class="btn-close btn-close-white ms-1" style="font-size: 0.5rem; width: 0.5em; height: 0.5em;"
                  onclick="removeSelfRole('${guildId}', '${panel.id}', '${opt.role_id}', this)"></button>
        </span>`;
      }).join('');

      card.innerHTML = `
        <div class="card-header border-secondary d-flex justify-content-between align-items-center">
          <div>
            <strong>${escapeHtml(panel.title || 'Self Roles')}</strong>
            <span class="text-muted ms-2" style="font-size: 0.8rem;">Panel #${panel.id} &bull; #${escapeHtml(panel.channel_id)}</span>
          </div>
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="deleteSelfRolePanel('${guildId}', '${panel.id}')">
            <i class="bi bi-trash"></i> Delete
          </button>
        </div>
        <div class="card-body">
          <div class="d-flex flex-wrap mb-3" id="selfrole-roles-${panel.id}">
            ${rolesList || '<span class="text-muted">No roles added yet</span>'}
          </div>
          <div class="d-flex gap-2 align-items-end flex-wrap">
            <div>
              <label class="setting-label" style="font-size:0.75rem;">Role</label>
              <select id="selfrole-add-role-${panel.id}" class="form-select form-select-sm" style="min-width:150px;">
                <option value="">-- Role --</option>
              </select>
            </div>
            <div>
              <label class="setting-label" style="font-size:0.75rem;">Emoji</label>
              <input type="text" id="selfrole-add-emoji-${panel.id}" class="form-control form-control-sm" placeholder="🎮" style="width:70px;">
            </div>
            <div>
              <label class="setting-label" style="font-size:0.75rem;">Label <span class="text-muted">(optional)</span></label>
              <input type="text" id="selfrole-add-label-${panel.id}" class="form-control form-control-sm" placeholder="Custom text" style="width:130px;">
            </div>
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="addSelfRole('${guildId}', '${panel.id}')">
              <i class="bi bi-plus-lg"></i> Add Role
            </button>
          </div>
        </div>
      `;
      container.appendChild(card);

      // Populate the role dropdown (excluding roles already on this panel)
      const roleSelect = document.getElementById(`selfrole-add-role-${panel.id}`);
      const existingRoleIds = panel.options.map(o => o.role_id);
      const allRoles = window.__guildRoles || [];
      allRoles.forEach(r => {
        if (!existingRoleIds.includes(r.id)) {
          const opt = document.createElement('option');
          opt.value = r.id;
          opt.textContent = r.name;
          roleSelect.appendChild(opt);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="text-danger">Error loading panels: ' + escapeHtml(err.message) + '</div>';
  }
}

async function createSelfRolePanel(guildId) {
  const channelId = document.getElementById('selfrole-new-channel').value;
  const title = document.getElementById('selfrole-new-title').value.trim();
  const description = document.getElementById('selfrole-new-desc').value.trim();

  if (!channelId) { showToast('Select a channel', 'error'); return; }

  try {
    const res = await fetch(`/api/guild/${guildId}/self-role-panels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, title: title || 'Self Roles', description: description || null }),
    });
    const result = await res.json();
    if (result.success) {
      showToast('Panel created! Now add roles to it.');
      loadSelfRolePanels(guildId);
      document.getElementById('selfrole-new-channel').value = '';
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function deleteSelfRolePanel(guildId, panelId) {
  if (!confirm('Delete this panel? The Discord message will also be removed.')) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/self-role-panels/${panelId}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      showToast('Panel deleted.');
      const card = document.getElementById(`selfrole-panel-${panelId}`);
      if (card) card.remove();
      // Check if no panels left
      const container = document.getElementById('selfrole-panels-container');
      if (container && container.children.length === 0) {
        container.innerHTML = '<div class="text-muted"><i class="bi bi-info-circle"></i> No self-role panels yet. Create one below.</div>';
      }
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function addSelfRole(guildId, panelId) {
  const roleId = document.getElementById(`selfrole-add-role-${panelId}`).value;
  const emoji = document.getElementById(`selfrole-add-emoji-${panelId}`).value.trim();
  const label = document.getElementById(`selfrole-add-label-${panelId}`).value.trim();

  if (!roleId) { showToast('Select a role', 'error'); return; }
  if (!emoji && !label) { showToast('Provide an emoji, a label, or both', 'error'); return; }

  try {
    const res = await fetch(`/api/guild/${guildId}/self-role-panels/${panelId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId, emoji: emoji || null, label: label || null }),
    });
    const result = await res.json();
    if (result.success) {
      showToast('Role added!');
      loadSelfRolePanels(guildId); // Refresh all panels
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function removeSelfRole(guildId, panelId, roleId, btn) {
  try {
    const res = await fetch(`/api/guild/${guildId}/self-role-panels/${panelId}/roles/${roleId}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      showToast('Role removed.');
      loadSelfRolePanels(guildId); // Refresh
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
