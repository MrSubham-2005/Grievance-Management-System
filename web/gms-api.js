// Shared client helper for the GMS pages. Talks to the JSON API under /api.
// Errors are shown with the server's own message, which says what went wrong and where to go next.
(function () {
    "use strict";

    async function call(method, url, body) {
        const options = { method: method, credentials: "same-origin", headers: {} };
        if (body !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(url, options);
        } catch (networkError) {
            throw new Error("Could not reach the GMS server. Check your connection and try again.");
        }
        let data = {};
        try {
            data = await response.json();
        } catch (parseError) {
            data = {};
        }
        if (!response.ok) {
            const error = new Error(data.error || "The request failed (" + response.status + "). Try again.");
            error.status = response.status;
            error.redirect = data.redirect || null;
            throw error;
        }
        return data;
    }

    window.GMS = {
        get: function (url) { return call("GET", url); },
        post: function (url, body) { return call("POST", url, body || {}); },
        // Sends a form's fields as JSON, using the field names the API expects.
        formData: function (form) {
            const data = {};
            new FormData(form).forEach(function (value, key) { data[key] = value; });
            return data;
        },
        // Shows a readable message. Falls back to alert when no inline box exists.
        notify: function (element, message, isError) {
            if (element) {
                element.textContent = message;
                element.style.color = isError ? "#c62828" : "#2e7d32";
                element.style.display = "block";
            } else {
                alert(message);
            }
        },
        // Moves the user on after success, or to the login page after a session error.
        go: function (url) { window.location.href = url; },
    };

    // Portal pages need a signed-in session for their role. Public pages (Home, login,
    // signup, forgot password) are left alone. Signed-out visitors are sent to the login
    // page for that portal, with a message that says why.
    var PORTAL_LOGIN = {
        STUDENTS: "/HTML/STUDENTS/student_login.html",
        STAFF: "/HTML/STAFF/staff_login.html",
        ADMIN: "/HTML/ADMIN/admin_login.html",
    };
    var path = window.location.pathname;
    var portal = null;
    Object.keys(PORTAL_LOGIN).forEach(function (name) {
        if (path.indexOf("/HTML/" + name + "/") === 0 && !/_(login|signup|forgot_password)\.html$/.test(path)) {
            portal = name;
        }
    });
    if (portal) {
        var roleKey = portal === "STUDENTS" ? "student" : portal === "STAFF" ? "staff" : "admin";
        // Hide the page until the session is confirmed, so private content never flashes.
        document.documentElement.style.visibility = "hidden";
        fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (session) {
                if (session[roleKey]) {
                    document.documentElement.style.visibility = "";
                    return;
                }
                window.location.replace(PORTAL_LOGIN[portal] + "?reason=signin");
            })
            .catch(function () {
                document.documentElement.style.visibility = "";
                alert("Could not check your sign-in status. Check your connection and reload the page.");
            });
    }
})();
