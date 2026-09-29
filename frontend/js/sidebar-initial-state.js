// Runs as the sidebar is parsed, before its links and the page content can paint.
(function () {
    const sidebar = document.getElementById('accordionSidebar');
    if (!sidebar) return;
    sidebar.dataset.role = window.AppAuth?.getRole?.() || '';
    let collapsed = false;
    try {
        collapsed = window.innerWidth >= 769 && localStorage.getItem('app-sidebar-collapsed') === 'true';
    } catch (_) {}
    document.body.classList.toggle('sidebar-toggled', collapsed);
    sidebar.classList.toggle('toggled', collapsed);
}());
