/* Theme detection — runs immediately to prevent FOUC.
   This file is loaded in <head> (render-blocking on purpose). */
(function() {
    var saved = localStorage.getItem('dmc-theme');
    var system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = saved || system;
    // Desktop app: set platform attribute for title bar CSS (before render)
    if (window.electronAPI && window.electronAPI.isDesktop) {
        document.documentElement.dataset.desktop = window.electronAPI.platform;
    }
})();

function updateThemeBtn(theme) {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.innerHTML = theme === 'dark' ? '<i class="ti ti-sun"></i>' : '<i class="ti ti-moon"></i>';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('dmc-theme', next);
    updateThemeBtn(next);
}

function toggleNav() {
    var nav = document.querySelector('.hd-nav');
    var btn = document.querySelector('.hamburger-btn');
    if (!nav) return;
    var opening = !nav.classList.contains('open');
    nav.classList.toggle('open', opening);
    if (btn) btn.innerHTML = opening ? '<i class="ti ti-x"></i>' : '<i class="ti ti-menu-2"></i>';
    var bd = document.querySelector('.nav-backdrop');
    if (opening) {
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        if (!bd) {
            bd = document.createElement('div');
            bd.className = 'nav-backdrop';
            bd.onclick = function() { toggleNav(); };
            document.body.appendChild(bd);
        }
    } else {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        if (bd) bd.remove();
    }
}

/* Set button icon once DOM is ready + nav dropdown toggle */
document.addEventListener('DOMContentLoaded', function() {
    updateThemeBtn(document.documentElement.dataset.theme);

    document.querySelectorAll('.nav-dropdown-trigger').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = btn.closest('.nav-dropdown');
            var wasOpen = dd.classList.contains('open');
            // Close all nav dropdowns first
            document.querySelectorAll('.nav-dropdown.open').forEach(function(d) {
                d.classList.remove('open');
            });
            if (!wasOpen) dd.classList.add('open');
        });
    });

    document.addEventListener('click', function() {
        document.querySelectorAll('.nav-dropdown.open').forEach(function(d) {
            d.classList.remove('open');
        });
    });
});
