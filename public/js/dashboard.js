function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const id = 'toast-' + Date.now();
  const bgClass = type === 'success' ? 'bg-success' : 'bg-danger';

  container.insertAdjacentHTML('beforeend', `
    <div id="${id}" class="toast align-items-center text-white ${bgClass} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>
  `);

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
      // Add badge to the list
      const list = document.getElementById('exempt-channels-list');
      list.insertAdjacentHTML('beforeend', `
        <span class="badge bg-secondary d-flex align-items-center gap-1 exempt-badge" data-channel-id="${channelId}">
          ${channelName}
          <button type="button" class="btn-close btn-close-white ms-1" style="font-size: 0.6rem;"
                  onclick="removeExemptChannel('${guildId}', '${channelId}', this)"></button>
        </span>
      `);

      // Remove from dropdown
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

      // Re-add to dropdown
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

// Initialize Bootstrap popovers
document.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => {
  new bootstrap.Popover(el);
});

// Reset custom message textarea to default (clear it)
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

async function deleteWarning(guildId, warningId) {
  if (!confirm('Are you sure you want to delete this warning?')) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/warnings/${warningId}`, {
      method: 'DELETE',
    });
    const result = await res.json();
    if (result.success) {
      const row = document.getElementById(`warning-row-${warningId}`);
      if (row) row.remove();
      showToast('Warning deleted.');
    } else {
      showToast(result.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}
