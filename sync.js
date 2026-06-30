// sync.js - CORE_OS Cloud Sync Engine
// Manages Google Drive API synchronization

const CLIENT_ID = '16762700329-lbf3o4meqh19oh341espj0715sulhfst.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'CORE_OS_Sync';
const FILE_NAME = 'state.json';

let tokenClient;
let accessToken = localStorage.getItem('core_os_access_token');
let tokenExpiry = parseInt(localStorage.getItem('core_os_token_expiry') || '0');

// If token has expired, clear it
if (accessToken && new Date().getTime() > tokenExpiry) {
    accessToken = null;
    localStorage.removeItem('core_os_access_token');
}

let syncFileId = localStorage.getItem('core_os_sync_file_id');
let syncFolderId = localStorage.getItem('core_os_sync_folder_id');

// Setup UI Element for Sync Status
function createSyncUI() {
    // Attempt to attach to internal-nav if it exists
    const nav = document.querySelector('.internal-nav');
    if (!nav) return;

    const syncContainer = document.createElement('div');
    syncContainer.id = 'sync-container';
    syncContainer.style.marginLeft = 'auto';
    syncContainer.style.marginRight = '15px';
    syncContainer.innerHTML = `
        <button id="sync-btn" style="background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border, rgba(255,255,255,0.12)); color: var(--text-main, #ffffff); padding: 8px 16px; border-radius: 16px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; transition: 0.3s; backdrop-filter: blur(10px);">
            <span id="sync-dot" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--danger, #d46a6a); box-shadow: 0 0 8px var(--danger, #d46a6a);"></span>
            <span id="sync-text">Drive Offline</span>
        </button>
    `;

    // Insert before the empty spacing div at the end of internal-nav
    nav.insertBefore(syncContainer, nav.lastElementChild);

    document.getElementById('sync-btn').addEventListener('click', handleAuthClick);
}

function updateSyncUI(status, message) {
    const dot = document.getElementById('sync-dot');
    const text = document.getElementById('sync-text');
    if (!dot || !text) return;

    if (status === 'connected') {
        dot.style.background = 'var(--success, #6ad48a)';
        dot.style.boxShadow = '0 0 8px var(--success, #6ad48a)';
        text.innerText = message || 'Drive Synced';
    } else if (status === 'syncing') {
        dot.style.background = 'var(--accent, #ffaa33)';
        dot.style.boxShadow = '0 0 8px var(--accent, #ffaa33)';
        text.innerText = message || 'Syncing...';
    } else if (status === 'error' || status === 'disconnected') {
        dot.style.background = 'var(--danger, #d46a6a)';
        dot.style.boxShadow = '0 0 8px var(--danger, #d46a6a)';
        text.innerText = message || 'Drive Offline';
    }
}

// GIS initialization
function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse.error !== undefined) {
                console.error(tokenResponse);
                updateSyncUI('error', 'Auth Failed');
                return;
            }
            accessToken = tokenResponse.access_token;

            // Cache token for 55 minutes (Google tokens expire in 60 mins)
            const expiry = new Date().getTime() + (55 * 60 * 1000);
            localStorage.setItem('core_os_access_token', accessToken);
            localStorage.setItem('core_os_token_expiry', expiry.toString());

            updateSyncUI('connected', 'Authenticating...');
            startSyncRoutine();
        },
    });

    // If we already have a valid cached token on page load, start sync automatically
    if (accessToken) {
        updateSyncUI('connected', 'Authenticating...');
        startSyncRoutine();
    }
}

function handleAuthClick() {
    if (tokenClient) {
        if (accessToken === null) {
            // First time or token expired
            tokenClient.requestAccessToken();
        } else {
            // Force sync if already connected
            startSyncRoutine();
        }
    } else {
        alert("Please set your Google Client ID in sync.js first!");
    }
}

// Google API Request Wrapper
async function gapiFetch(url, method = 'GET', body = null) {
    if (!accessToken) return null;
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    const options = { method, headers };
    if (body) {
        if (typeof body === 'string') {
            options.body = body; // Multipart or string
        } else {
            options.body = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
        }
    }
    const res = await fetch(url, options);
    if (!res.ok) {
        if (res.status === 401) {
            accessToken = null;
            updateSyncUI('disconnected', 'Session Expired');
        }
        throw new Error(`Google API Error: ${res.status}`);
    }
    return res.json();
}

async function startSyncRoutine() {
    updateSyncUI('syncing', 'Finding Cloud Data...');
    try {
        if (!syncFolderId) {
            // Search for folder
            const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
            const searchRes = await gapiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}`);
            if (searchRes && searchRes.files && searchRes.files.length > 0) {
                syncFolderId = searchRes.files[0].id;
            } else {
                // Create folder
                const folderMetadata = { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' };
                const createRes = await gapiFetch('https://www.googleapis.com/drive/v3/files', 'POST', folderMetadata);
                syncFolderId = createRes.id;
            }
            localStorage.setItem('core_os_sync_folder_id', syncFolderId);
        }

        if (!syncFileId) {
            const q = encodeURIComponent(`name='${FILE_NAME}' and '${syncFolderId}' in parents and trashed=false`);
            const searchRes = await gapiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)`);
            if (searchRes && searchRes.files && searchRes.files.length > 0) {
                syncFileId = searchRes.files[0].id;
                localStorage.setItem('core_os_sync_file_id', syncFileId);
            }
        }

        // Proceed to sync
        await performSync();

    } catch (err) {
        console.error("Sync Routine Error:", err);
        updateSyncUI('error', 'Sync Failed');
    }
}

async function performSync() {
    updateSyncUI('syncing', 'Comparing States...');
    try {
        let cloudModified = 0;
        if (syncFileId) {
            // Get cloud metadata
            const metaRes = await gapiFetch(`https://www.googleapis.com/drive/v3/files/${syncFileId}?fields=modifiedTime`);
            cloudModified = new Date(metaRes.modifiedTime).getTime();
        }

        const localModified = parseInt(localStorage.getItem('core_os_last_edit')) || 0;

        if (cloudModified > localModified) {
            // CLOUD IS NEWER - PULL FROM CLOUD
            updateSyncUI('syncing', 'Downloading Updates...');
            const rawRes = await fetch(`https://www.googleapis.com/drive/v3/files/${syncFileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const cloudData = await rawRes.json();

            // Overwrite local databases
            if (cloudData.tasks) localStorage.setItem('core_os_daily_tasks', JSON.stringify(cloudData.tasks));
            if (cloudData.projects) localStorage.setItem('core_os_projects_db', JSON.stringify(cloudData.projects));
            if (cloudData.academic) localStorage.setItem('core_os_academic_db', JSON.stringify(cloudData.academic));
            if (cloudData.gate) localStorage.setItem('core_os_gate_db', JSON.stringify(cloudData.gate));

            localStorage.setItem('core_os_last_edit', cloudModified.toString());

            // Auto reload UI to reflect new data
            if (typeof window.onCloudSyncData === 'function') {
                window.onCloudSyncData();
            } else {
                window.location.reload();
            }

        } else if (localModified > cloudModified || !syncFileId) {
            // LOCAL IS NEWER OR CLOUD FILE DOESN'T EXIST - PUSH TO CLOUD
            await pushToCloud();
            return; // pushToCloud handles its own UI updates
        }

        updateSyncUI('connected', 'All Synced');
    } catch (err) {
        console.error("Perform Sync Error:", err);
        updateSyncUI('error', 'Sync Failed');
    }
}

async function pushToCloud() {
    if (!accessToken) return;

    updateSyncUI('syncing', 'Saving to Cloud...');

    // Gather state
    const stateObj = {
        tasks: JSON.parse(localStorage.getItem('core_os_daily_tasks') || '{}'),
        projects: JSON.parse(localStorage.getItem('core_os_projects_db') || '{}'),
        academic: JSON.parse(localStorage.getItem('core_os_academic_db') || '{}'),
        gate: JSON.parse(localStorage.getItem('core_os_gate_db') || '{}'),
        timestamp: new Date().getTime()
    };

    const fileContent = JSON.stringify(stateObj);
    const metadata = { name: FILE_NAME, mimeType: 'application/json' };

    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    let multipartRequestBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        fileContent +
        close_delim;

    try {
        if (syncFileId) {
            // UPDATE EXISTING FILE
            const req = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${syncFileId}?uploadType=multipart`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: multipartRequestBody
            });
            const res = await req.json();

            // Update local time to match Google's exact modified time
            const metaReq = await gapiFetch(`https://www.googleapis.com/drive/v3/files/${syncFileId}?fields=modifiedTime`);
            localStorage.setItem('core_os_last_edit', new Date(metaReq.modifiedTime).getTime().toString());

        } else {
            // CREATE NEW FILE
            metadata.parents = [syncFolderId];
            multipartRequestBody =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                fileContent +
                close_delim;

            const req = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: multipartRequestBody
            });
            const res = await req.json();
            syncFileId = res.id;
            localStorage.setItem('core_os_sync_file_id', syncFileId);
            localStorage.setItem('core_os_last_edit', new Date().getTime().toString());
        }

        updateSyncUI('connected', 'All Synced');
    } catch (err) {
        console.error("Push Error:", err);
        updateSyncUI('error', 'Upload Failed');
    }
}

// File Upload to Drive
async function uploadRawFileToDrive(file, fileName) {
    if (!accessToken) throw new Error("Not connected to Drive");
    updateSyncUI('syncing', 'Uploading File...');

    const metadata = { name: fileName, parents: [syncFolderId] };
    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const reader = new FileReader();
    return new Promise((resolve, reject) => {
        reader.onload = async function (e) {
            const base64Data = e.target.result.split('base64,')[1];

            let multipartRequestBody =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: ' + file.type + '\r\n' +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                base64Data +
                close_delim;

            try {
                const req = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': `multipart/related; boundary=${boundary}`
                    },
                    body: multipartRequestBody
                });
                const res = await req.json();
                updateSyncUI('connected', 'File Uploaded');
                resolve(res);
            } catch (err) {
                console.error("Upload Error:", err);
                updateSyncUI('error', 'Upload Failed');
                reject(err);
            }
        };
        reader.readAsDataURL(file);
    });
}

// Delete physical file from Drive
async function deleteFileFromDrive(url) {
    if (!accessToken || !url) return;

    // Extract ID from url (e.g. https://drive.google.com/file/d/1X2Y.../view)
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return;
    const fileId = match[1];

    try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        console.log('File deleted from Drive:', fileId);
    } catch (err) {
        console.error('Failed to delete file from Drive:', err);
    }
}

// Hook into local changes (auto-sync trigger)
// Call this function whenever you make a change in the local app.
function notifySyncEngineOfChange() {
    localStorage.setItem('core_os_last_edit', new Date().getTime().toString());

    // Debounce the push to avoid spamming the API
    clearTimeout(window.syncTimeout);
    window.syncTimeout = setTimeout(() => {
        if (accessToken) pushToCloud();
    }, 2000);
}

// Init script loading automatically
window.addEventListener('DOMContentLoaded', () => {
    createSyncUI();

    // Load Google Identity Services dynamically
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = gisLoaded;
    document.head.appendChild(script);
});
