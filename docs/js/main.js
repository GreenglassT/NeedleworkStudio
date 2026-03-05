/* Theme toggle + screenshot swapping */
(function () {
    var key = 'ns-docs-theme';
    var saved = localStorage.getItem(key);
    if (saved) document.documentElement.setAttribute('data-theme', saved);

    function isDark() {
        return document.documentElement.getAttribute('data-theme') !== 'light';
    }

    function updateScreenshots() {
        var suffix = isDark() ? 'dark' : 'light';
        document.querySelectorAll('img.screenshot[data-dark][data-light]').forEach(function (img) {
            img.src = img.getAttribute('data-' + suffix);
        });
    }

    /* Swap screenshots on initial load to match saved theme */
    updateScreenshots();

    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.theme-toggle');
        if (!btn) return;

        function updateBtn() {
            btn.textContent = isDark() ? '\u2600' : '\u263E';
            btn.title = isDark() ? 'Switch to light mode' : 'Switch to dark mode';
        }
        updateBtn();

        btn.addEventListener('click', function () {
            if (isDark()) {
                document.documentElement.setAttribute('data-theme', 'light');
                localStorage.setItem(key, 'light');
            } else {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem(key, '');
            }
            updateBtn();
            updateScreenshots();
        });

        /* Also swap screenshots after DOM ready in case images loaded late */
        updateScreenshots();
    });
})();

/* Mobile nav */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var hamburger = document.querySelector('.hamburger');
        var nav = document.querySelector('.nav');
        var backdrop = document.querySelector('.nav-backdrop');
        if (!hamburger || !nav) return;

        function toggle(open) {
            nav.classList.toggle('open', open);
            if (backdrop) backdrop.classList.toggle('show', open);
        }
        hamburger.addEventListener('click', function () { toggle(!nav.classList.contains('open')); });
        if (backdrop) backdrop.addEventListener('click', function () { toggle(false); });
    });
})();

/* Wiki mobile sidebar toggle */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.wiki-mobile-toggle');
        var sidebar = document.querySelector('.wiki-sidebar');
        if (!btn || !sidebar) return;
        btn.addEventListener('click', function () {
            var open = sidebar.classList.toggle('open');
            btn.textContent = open ? '\u25B2 Hide navigation' : '\u25BC Show navigation';
        });
    });
})();

/* Wiki sidebar section links */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var activeLink = document.querySelector('.sidebar-link.active');
        var content = document.querySelector('.wiki-content');
        if (!activeLink || !content) return;

        var headings = content.querySelectorAll('h2');
        if (headings.length === 0) return;

        /* Generate slug IDs and build sub-nav */
        var subNav = document.createElement('div');
        subNav.className = 'sidebar-sub';

        headings.forEach(function (h2) {
            /* Create an id from heading text */
            var id = h2.id || h2.textContent.trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            h2.id = id;

            var link = document.createElement('a');
            link.href = '#' + id;
            link.className = 'sidebar-sublink';
            link.textContent = h2.textContent.trim();
            link.addEventListener('click', function (e) {
                e.preventDefault();
                h2.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', '#' + id);
            });
            subNav.appendChild(link);
        });

        activeLink.parentNode.insertBefore(subNav, activeLink.nextSibling);

        /* Highlight current section on scroll */
        var sublinks = subNav.querySelectorAll('.sidebar-sublink');
        var headingArr = Array.prototype.slice.call(headings);
        var ticking = false;

        function updateActive() {
            var scrollY = window.scrollY + 100;
            var current = null;
            for (var i = headingArr.length - 1; i >= 0; i--) {
                if (headingArr[i].offsetTop <= scrollY) {
                    current = headingArr[i];
                    break;
                }
            }
            sublinks.forEach(function (sl) {
                sl.classList.toggle('active', current && sl.getAttribute('href') === '#' + current.id);
            });
            ticking = false;
        }

        window.addEventListener('scroll', function () {
            if (!ticking) {
                requestAnimationFrame(updateActive);
                ticking = true;
            }
        });
        updateActive();
    });
})();

/* OS detection for download button */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.hero-download');
        if (!btn) return;
        var ua = navigator.userAgent.toLowerCase();
        if (ua.indexOf('mac') !== -1) {
            btn.textContent = 'Download for macOS';
            btn.href = 'https://github.com/GreenglassT/NeedleworkStudio/releases/latest/download/Needlework-Studio-0.2.4-arm64.dmg';
        } else if (ua.indexOf('win') !== -1) {
            btn.textContent = 'Download for Windows';
            btn.href = 'https://github.com/GreenglassT/NeedleworkStudio/releases/latest/download/Needlework-Studio-Setup-0.2.4.exe';
        } else if (ua.indexOf('linux') !== -1) {
            btn.textContent = 'Download for Linux';
            btn.href = 'https://github.com/GreenglassT/NeedleworkStudio/releases/latest/download/Needlework-Studio-0.2.4.AppImage';
        }
    });
})();
