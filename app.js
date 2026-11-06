let hospitals = [];
let role = "student";
let csrfToken = "";
let adminUsername = "";
let adminFullName = "";
let administratorRole = "admin";
let selectedHospitalId = null;
let editingHospitalId = null;
let pendingDelete = null;
let hospitalStudentsId = null;
let currentBooking = null;
let hospitalSearchTimer = null;
let adminSearchTimer = null;
let bookingRows = [];
let cancelledRows = [];
let notificationTimer = null;
let bookingSort = { key: "createdAt", direction: "desc" };

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (role === "admin" && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && role === "admin") showStudentPortal();
    throw new Error(result?.error || "The request could not be completed.");
  }
  return result;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.style.background = error ? "#991b1b" : "#10243e";
  element.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.style.display = "none"; }, 4000);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "Please wait...";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function canWrite() {
  return role === "admin" && administratorRole !== "read_only_admin";
}

function applyRolePermissions() {
  document.querySelectorAll(".write-only").forEach(element => element.classList.toggle("hidden", !canWrite()));
  document.querySelectorAll("[data-super-admin-only]").forEach(element => element.classList.toggle("hidden", administratorRole !== "super_admin"));
}

function isFull(hospital) {
  return hospital.booked >= hospital.capacity;
}

function isLocked(hospital) {
  return Boolean(hospital.manuallyLocked) || isFull(hospital);
}

function renderHospitals() {
  const query = ($("#search").value || "").trim().toLowerCase();
  const county = $("#countyFilter").value;
  const counties = [...new Set(hospitals.map(hospital => hospital.county))].sort((a, b) => a.localeCompare(b));
  const previousCounty = county;
  $("#countyFilter").innerHTML = `<option value="">All counties</option>${counties.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
  if (counties.includes(previousCounty)) $("#countyFilter").value = previousCounty;

  const visible = hospitals.filter(hospital =>
    `${hospital.name} ${hospital.county}`.toLowerCase().includes(query) &&
    (!previousCounty || hospital.county === previousCounty)
  );
  $("#hospitalGrid").innerHTML = visible.map(hospital => {
    const full = isFull(hospital);
    const locked = isLocked(hospital);
    const percent = hospital.capacity ? Math.min(100, Math.round(hospital.booked / hospital.capacity * 100)) : 0;
    const status = full ? "FULL · LOCKED" : locked ? "LOCKED" : "OPEN";
    return `<article class="hospital">
      <div style="display:flex;justify-content:space-between;gap:8px"><span class="badge ${full ? "full" : locked ? "closed" : "open"}">${status}</span><span style="font-size:12px;color:#64748b">${esc(hospital.county)}</span></div>
      <h4 style="margin-top:13px">${esc(hospital.name)}</h4>
      <div class="location">${esc(hospital.department)} · ${esc(hospital.county)} County</div>
      <div class="meta"><span>Capacity: <b>${hospital.capacity}</b></span><span>Booked: <b>${hospital.booked}</b></span></div>
      <div class="progress"><span class="${full ? "full" : ""}" style="width:${percent}%"></span></div>
      <div class="meta"><span>${hospital.availableSlots} slot${hospital.availableSlots === 1 ? "" : "s"} available</span><span>${percent}% filled</span></div>
      <div class="actions">${locked
        ? '<button class="muted-btn" disabled>Booking locked</button>'
        : `<button class="primary" data-book-hospital="${hospital.id}">Book this hospital</button>`}</div>
      ${locked ? `<div class="locked-note">${full ? "This hospital is full." : "Bookings are closed by an administrator."} Student booking is disabled.</div>` : ""}
    </article>`;
  }).join("") || '<div class="loading">No hospitals match your search.</div>';
  $("#hospitalGrid").querySelectorAll("[data-book-hospital]").forEach(button => {
    button.addEventListener("click", () => openBookingForm(Number(button.dataset.bookHospital)));
  });
}

async function loadHospitals() {
  const result = await api("/api/hospitals");
  hospitals = result.hospitals;
  renderHospitals();
  if (role === "admin") await refreshAdmin();
}

function openBookingForm(hospitalId) {
  if (currentBooking) {
    toast("A booking is already saved in this browser. Check your booking or use another browser to submit a different admission number.", true);
    return;
  }
  const hospital = hospitals.find(item => item.id === hospitalId);
  if (!hospital || isLocked(hospital)) {
    toast("This hospital is no longer available.", true);
    loadHospitals().catch(showError);
    return;
  }
  selectedHospitalId = hospitalId;
  $("#studentBookingForm").reset();
  $("#selectedHospital").textContent = hospital.name;
  $("#bookingFormMessage").classList.add("hidden");
  $("#bookingPanel").classList.remove("hidden");
  $("#bookingPanel").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#studentFullName").focus();
}

function closeBookingForm() {
  $("#bookingPanel").classList.add("hidden");
  $("#studentBookingForm").reset();
  selectedHospitalId = null;
}

async function submitBooking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, "Submitting...");
  $("#bookingFormMessage").classList.add("hidden");
  try {
    const result = await api("/api/student/bookings", {
      method: "POST",
      body: JSON.stringify({
        hospitalId: selectedHospitalId,
        fullName: $("#studentFullName").value,
        admissionNumber: $("#studentAdmission").value
      })
    });
    currentBooking = result.booking;
    localStorage.setItem(`af_cancel_${currentBooking.id}`, result.cancelToken);
    hospitals = hospitals.map(hospital => hospital.id === result.hospital.id ? result.hospital : hospital);
    closeBookingForm();
    renderHospitals();
    renderBookingConfirmation(currentBooking, true);
    await refreshAdminIfVisible();
    toast("Your hospital attachment booking has been successfully submitted.");
  } catch (error) {
    $("#bookingFormMessage").textContent = error.message;
    $("#bookingFormMessage").classList.remove("hidden");
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

function renderBookingConfirmation(booking, canCancel) {
  $("#myBooking").classList.remove("hidden");
  $("#myBooking").innerHTML = `<div class="success-message"><b>Your hospital attachment booking has been successfully submitted.</b><br><br>
    <b>${esc(booking.hospital)}</b><br>Student: ${esc(booking.fullName)}<br>
    Admission Number: ${esc(booking.admissionNumber)}<br>Course: ${esc(booking.course)}<br>
    Campus: ${esc(booking.campus)}<br>Year of Study: ${esc(booking.yearOfStudy)}<br>
    Booking status: ${esc(booking.status || "Booked")}
  </div>${canCancel ? `<button class="danger" style="margin-top:12px" data-cancel-booking="${esc(booking.id)}">Cancel this booking</button><small style="display:block;margin-top:8px;color:var(--muted)">Cancellation is available from the browser used to place the booking.</small>` : ""}`;
  $("#myBooking").querySelector("[data-cancel-booking]")?.addEventListener("click", () => cancelOwnBooking(booking.id));
}

async function cancelOwnBooking(id) {
  const cancelToken = localStorage.getItem(`af_cancel_${id}`);
  if (!cancelToken) {
    toast("This booking can only be cancelled from the browser used to place it. Contact an administrator if you need help.", true);
    return;
  }
  try {
    await api(`/api/student/bookings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ cancelToken })
    });
    localStorage.removeItem(`af_cancel_${id}`);
    currentBooking = null;
    $("#myBooking").classList.add("hidden");
    $("#myBooking").innerHTML = "";
    await loadHospitals();
    toast("Booking cancelled and hospital availability updated.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function lookupBooking(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const resultElement = $("#lookupResult");
  resultElement.classList.remove("hidden");
  resultElement.innerHTML = '<div class="loading">Checking booking...</div>';
  setBusy(button, true, "Checking...");
  try {
    const result = await api("/api/student/lookup", {
      method: "POST",
      body: JSON.stringify({ admissionNumber: $("#lookupAdmission").value })
    });
    if (!result.found) {
      resultElement.innerHTML = '<div class="notice warning">No booking was found for that admission number.</div>';
    } else {
      resultElement.innerHTML = `<div class="success-message">Booking found.<br><b>Hospital:</b> ${esc(result.booking.hospital)}<br><b>Status:</b> ${esc(result.booking.status)}</div>`;
    }
  } catch (error) {
    resultElement.innerHTML = `<div class="error-message">${esc(error.message)}</div>`;
  } finally {
    setBusy(button, false);
  }
}

function showAdminLogin() {
  $("#adminLoginError").classList.add("hidden");
  $("#adminLoginForm").reset();
  $("#adminPasswordInput").type = "password";
  $("#toggleAdminPassword").textContent = "Show";
  $("#toggleAdminPassword").setAttribute("aria-pressed", "false");
  $("#adminLoginDialog").showModal();
  $("#adminUsernameInput").focus();
}

function toggleAdminPassword() {
  const passwordInput = $("#adminPasswordInput");
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  $("#toggleAdminPassword").textContent = isVisible ? "Show" : "Hide";
  $("#toggleAdminPassword").setAttribute("aria-pressed", String(!isVisible));
}

async function signInAdmin(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const errorElement = $("#adminLoginError");
  errorElement.classList.add("hidden");
  setBusy(button, true, "Signing in...");
  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#adminUsernameInput").value, password: $("#adminPasswordInput").value })
    });
    role = "admin";
    csrfToken = result.csrfToken;
    adminUsername = result.username;
    adminFullName = result.fullName || result.username;
    administratorRole = result.role;
    $("#adminLoginDialog").close();
    showAdminPortal();
    await refreshAdmin();
    selectAdminTab("overview");
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.classList.remove("hidden");
  } finally {
    setBusy(button, false);
  }
}

function showAdminRegistration(token = "") {
  const inviteToken = token || "";
  const form = $("#adminRegistrationForm");
  form.reset();
  $("#registrationInviteToken").value = inviteToken;
  $("#registrationInviteNotice").classList.toggle("hidden", Boolean(inviteToken));
  form.classList.toggle("hidden", !inviteToken);
  $("#registrationError").classList.add("hidden");
  $("#adminRegistrationDialog").showModal();
  $("#registrationFullName").focus();
}

async function registerAdministrator(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, "Creating account...");
  $("#registrationError").classList.add("hidden");
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        token: $("#registrationInviteToken").value,
        fullName: $("#registrationFullName").value,
        username: $("#registrationUsername").value,
        email: $("#registrationEmail").value,
        password: $("#registrationPassword").value,
        confirmPassword: $("#registrationConfirmPassword").value
      })
    });
    form.reset();
    $("#adminRegistrationDialog").close();
    $("#adminLoginDialog").showModal();
    toast("Administrator account created. You can now sign in.");
  } catch (error) {
    $("#registrationError").textContent = error.message;
    $("#registrationError").classList.remove("hidden");
  } finally {
    setBusy(button, false);
  }
}

async function requestAdminPasswordReset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, "Sending...");
  $("#recoveryMessage").classList.add("hidden");
  $("#recoveryMessage").classList.remove("error-message");
  try {
    const result = await api("/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: $("#recoveryEmail").value })
    });
    $("#recoveryMessage").textContent = result.message;
    $("#recoveryMessage").classList.remove("hidden");
  } catch (error) {
    $("#recoveryMessage").textContent = error.message;
    $("#recoveryMessage").classList.remove("hidden");
    $("#recoveryMessage").classList.add("error-message");
  } finally {
    setBusy(button, false);
  }
}

async function resetAdministratorPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const password = $("#resetPassword").value;
  if (password !== $("#resetConfirmPassword").value) {
    $("#resetError").textContent = "The passwords do not match.";
    $("#resetError").classList.remove("hidden");
    return;
  }
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, "Updating...");
  try {
    await api("/api/auth/password-reset/complete", {
      method: "POST",
      body: JSON.stringify({ token: $("#resetToken").value, password, confirmPassword: $("#resetConfirmPassword").value })
    });
    form.reset();
    $("#adminResetDialog").close();
    $("#adminLoginDialog").showModal();
    toast("Administrator password reset successfully. Sign in with your new password.");
  } catch (error) {
    $("#resetError").textContent = error.message;
    $("#resetError").classList.remove("hidden");
  } finally {
    setBusy(button, false);
  }
}

async function verifyAdministratorEmail() {
  const button = $("#verifyEmailButton");
  setBusy(button, true, "Verifying...");
  try {
    await api("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: $("#verifyEmailToken").value })
    });
    $("#adminVerifyDialog").close();
    $("#adminLoginDialog").showModal();
    toast("Email verified. You can now sign in.");
  } catch (error) {
    $("#verifyEmailError").textContent = error.message;
    $("#verifyEmailError").classList.remove("hidden");
  } finally {
    setBusy(button, false);
  }
}

async function logoutAdmin() {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
  } catch (error) {
    if (!/sign-in is required|session has expired/i.test(error.message)) toast(error.message, true);
  }
  showStudentPortal();
  toast("Administrator signed out.");
}

function showAdminPortal() {
  if (location.pathname !== "/admin") history.replaceState(null, "", "/admin");
  $("#studentView").classList.add("hidden");
  $("#adminView").classList.remove("hidden");
  $("#roleLabel").textContent = administratorRole === "super_admin" ? "Super Administrator" : "Administrator Portal";
  $("#adminUsername").textContent = adminFullName || adminUsername;
  $("#adminLoginButton").classList.add("hidden");
  $("#adminLogoutButton").classList.remove("hidden");
  $("#notificationButton").classList.remove("hidden");
  $("#pageTitle").textContent = "Administrator dashboard";
  $("#pageSubtitle").textContent = "Manage hospitals, student allocations, and system reports.";
  applyRolePermissions();
  refreshNotifications().catch(showError);
  clearInterval(notificationTimer);
  notificationTimer = setInterval(() => refreshNotifications().catch(showError), 60_000);
}

function showStudentPortal() {
  role = "student";
  csrfToken = "";
  adminUsername = "";
  adminFullName = "";
  administratorRole = "admin";
  clearInterval(notificationTimer);
  $("#notificationButton").classList.add("hidden");
  $("#notificationCount").classList.add("hidden");
  if (location.pathname === "/admin") history.replaceState(null, "", "/");
  $("#adminView").classList.add("hidden");
  $("#studentView").classList.remove("hidden");
  $("#roleLabel").textContent = "Student Portal";
  $("#adminLoginButton").classList.remove("hidden");
  $("#adminLogoutButton").classList.add("hidden");
  $("#pageTitle").textContent = "Find your clinical attachment";
  $("#pageSubtitle").textContent = "Choose from approved hospitals. Availability updates automatically.";
  $("#adminTable").innerHTML = "";
  $("#studentRecordsTable").innerHTML = "";
  $("#hospitalStudentsTable").innerHTML = "";
  $("#logTable").innerHTML = "";
  loadHospitals().catch(showError);
}

function selectAdminTab(tab) {
  if (role !== "admin") return;
  document.querySelectorAll("[data-admin-section]").forEach(section => {
    section.classList.toggle("hidden", section.dataset.adminSection !== tab);
  });
  document.querySelectorAll("[data-admin-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.adminTab === tab);
  });
  if (tab === "reports" || tab === "overview") loadOverview().catch(showError);
  if (tab === "hospitals") loadAdminHospitals().catch(showError);
  if (tab === "bookings") loadAdminBookings().catch(showError);
  if (tab === "booking-history") loadConfirmedBookingHistory().catch(showError);
  if (tab === "activity") loadAdminLogs().catch(showError);
  if (tab === "settings") loadSettings().catch(showError);
  if (tab === "administrators") loadAdministrators().catch(showError);
  $("#adminNavigation").classList.remove("collapsed");
}

function toggleAdminSidebar() {
  const navigation = $("#adminNavigation");
  const collapsed = navigation.classList.toggle("collapsed");
  document.querySelector(".sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
}

async function loadAdminHospitals() {
  const result = await api("/api/admin/hospitals");
  hospitals = result.hospitals;
  renderHospitals();
  renderAdminHospitals();
}

function renderAdminHospitals() {
  if (role !== "admin") return;
  const actionButtons = hospital => canWrite()
    ? `<div class="row-actions"><button class="secondary" data-edit-hospital="${hospital.id}">Edit</button><button class="muted-btn" data-lock-hospital="${hospital.id}">${hospital.manuallyLocked ? "Unlock" : "Lock"}</button><button class="danger" data-delete-hospital="${hospital.id}">Delete</button></div>`
    : '<span class="muted">Read only</span>';
  const table = $("#adminTable");
  table.innerHTML = hospitals.map(hospital => `<tr>
    <td><b>${esc(hospital.name)}</b><br><small>${esc(hospital.department)}</small></td>
    <td>${esc(hospital.county)}</td><td>${hospital.capacity}</td><td>${hospital.booked}</td>
    <td>${hospital.availableSlots}</td><td>${hospital.occupancyRate}%</td><td><span class="badge ${hospital.full ? "full" : hospital.locked ? "closed" : "open"}">${hospital.status}</span></td>
    <td><button class="secondary" data-view-students="${hospital.id}">View students</button></td>
    <td>${actionButtons(hospital)}</td>
  </tr>`).join("") || '<tr><td colspan="9">No hospitals added yet.</td></tr>';
  table.querySelectorAll("[data-edit-hospital]").forEach(button => button.addEventListener("click", () => editHospital(Number(button.dataset.editHospital))));
  table.querySelectorAll("[data-lock-hospital]").forEach(button => button.addEventListener("click", () => toggleHospitalLock(Number(button.dataset.lockHospital))));
  table.querySelectorAll("[data-delete-hospital]").forEach(button => button.addEventListener("click", () => requestDeleteHospital(Number(button.dataset.deleteHospital))));
  table.querySelectorAll("[data-view-students]").forEach(button => button.addEventListener("click", () => showHospitalStudents(Number(button.dataset.viewStudents))));
}

function showAddHospital() {
  if (!canWrite()) return;
  editingHospitalId = null;
  $("#hospitalFormTitle").textContent = "Add hospital";
  $("#saveHospitalButton").textContent = "Save hospital";
  $("#hospitalForm").reset();
  $("#newDepartment").value = "Occupational Therapy";
  $("#addPanel").classList.remove("hidden");
  $("#newName").focus();
}

function editHospital(id) {
  const hospital = hospitals.find(item => item.id === id);
  if (!hospital || !canWrite()) return;
  editingHospitalId = id;
  $("#hospitalFormTitle").textContent = "Edit hospital details";
  $("#saveHospitalButton").textContent = "Save changes";
  $("#newName").value = hospital.name;
  $("#newCounty").value = hospital.county;
  $("#newCapacity").value = hospital.capacity;
  $("#newDepartment").value = hospital.department;
  $("#addPanel").classList.remove("hidden");
  $("#addPanel").scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideAddHospital() {
  $("#addPanel").classList.add("hidden");
  $("#hospitalForm").reset();
  editingHospitalId = null;
}

async function saveHospital(event) {
  event.preventDefault();
  const button = $("#saveHospitalButton");
  const body = {
    name: $("#newName").value.trim(),
    county: $("#newCounty").value.trim(),
    department: $("#newDepartment").value.trim(),
    capacity: Number($("#newCapacity").value)
  };
  setBusy(button, true, "Saving...");
  try {
    const endpoint = editingHospitalId === null ? "/api/admin/hospitals" : `/api/admin/hospitals/${editingHospitalId}`;
    const result = await api(endpoint, { method: editingHospitalId === null ? "POST" : "PUT", body: JSON.stringify(body) });
    const message = editingHospitalId === null ? "Hospital added." : "Hospital updated.";
    hideAddHospital();
    await refreshAdmin();
    toast(message);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleHospitalLock(id) {
  const hospital = hospitals.find(item => item.id === id);
  if (!hospital) return;
  try {
    await api(`/api/admin/hospitals/${id}/lock`, {
      method: "PUT",
      body: JSON.stringify({ locked: !hospital.locked })
    });
    await refreshAdmin();
    toast(hospital.locked ? "Hospital bookings unlocked." : "Hospital bookings locked.");
  } catch (error) {
    toast(error.message, true);
  }
}

function requestDeleteHospital(id) {
  const hospital = hospitals.find(item => item.id === id);
  if (!hospital) return;
  openDeleteDialog("hospital", id, "Delete hospital?", `Delete ${hospital.name}? Its ${hospital.booked} student booking${hospital.booked === 1 ? "" : "s"} will also be removed.`, "Delete hospital");
}

function requestDeleteBooking(id, fullName, hospital) {
  openDeleteDialog("booking", id, "Delete student booking?", `Remove ${fullName}'s booking at ${hospital}? This restores one available slot.`, "Delete booking");
}

function openDeleteDialog(type, id, title, message, buttonText) {
  pendingDelete = { type, id };
  $("#deleteDialogTitle").textContent = title;
  $("#deleteDialogMessage").textContent = message;
  $("#deleteDialogConfirmButton").textContent = buttonText;
  $("#deleteDialog").showModal();
}

function closeDeleteDialog() {
  $("#deleteDialog").close();
  pendingDelete = null;
}

async function confirmDelete() {
  if (!pendingDelete || !canWrite()) return;
  const target = pendingDelete;
  const button = $("#deleteDialogConfirmButton");
  setBusy(button, true, "Deleting...");
  try {
    if (target.type === "hospital") {
      await api(`/api/admin/hospitals/${target.id}`, { method: "DELETE" });
    } else {
      await api(`/api/admin/bookings/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    }
    closeDeleteDialog();
    await refreshAdmin();
    toast(target.type === "hospital" ? "Hospital deleted." : "Booking removed and slot restored.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function loadAdminBookings() {
  if (role !== "admin") return;
  const params = new URLSearchParams();
  const query = $("#recordSearch").value.trim();
  const hospitalId = hospitalStudentsId || $("#recordHospitalFilter").value;
  if (query) params.set("q", query);
  if (hospitalId) params.set("hospitalId", hospitalId);
  const result = await api(`/api/admin/bookings?${params}`);
  renderAdminBookings(result.bookings);
}

function renderAdminBookings(bookings) {
  if (role !== "admin") return;
  bookingRows = bookings;
  const hospitalOptions = hospitals.map(hospital => `<option value="${hospital.id}">${esc(hospital.name)}</option>`).join("");
  const filter = $("#recordHospitalFilter");
  const previousValue = hospitalStudentsId ? String(hospitalStudentsId) : filter.value;
  filter.innerHTML = `<option value="">All hospitals</option>${hospitalOptions}`;
  if ([...filter.options].some(option => option.value === previousValue)) filter.value = previousValue;
  $("#allRecordsTableWrap").classList.toggle("hidden", hospitalStudentsId !== null);
  $("#hospitalStudentsView").classList.toggle("hidden", hospitalStudentsId === null);
  const tbody = hospitalStudentsId === null ? $("#studentRecordsTable") : $("#hospitalStudentsTable");
  if (hospitalStudentsId !== null) {
    const hospital = hospitals.find(item => item.id === hospitalStudentsId);
    $("#hospitalStudentsTitle").textContent = hospital ? `Students at ${hospital.name}` : "Hospital student records";
  }
  const sortedBookings = bookings.slice().sort((left, right) => {
    const first = String(left[bookingSort.key] ?? "").toLocaleLowerCase();
    const second = String(right[bookingSort.key] ?? "").toLocaleLowerCase();
    return first.localeCompare(second, undefined, { numeric: true }) * (bookingSort.direction === "asc" ? 1 : -1);
  });
  tbody.innerHTML = sortedBookings.map((booking, index) => `<tr>
    <td>${index + 1}</td><td>${esc(booking.fullName)}</td><td>${esc(booking.admissionNumber)}</td>
    <td>${esc(booking.hospital)}</td><td><span class="badge open">${esc(booking.status)}</span></td>
    <td>${esc(formatDate(booking.createdAt))}</td>
    <td><div class="row-actions"><button class="secondary" data-view-booking="${esc(booking.id)}">View details</button>${canWrite() ? `<button class="danger" data-delete-booking="${esc(booking.id)}" data-student="${esc(booking.fullName)}" data-hospital="${esc(booking.hospital)}">Remove</button>` : ""}</div></td>
  </tr>`).join("") || `<tr><td colspan="8">${hospitalStudentsId === null ? "No student bookings yet." : "No bookings for this hospital yet."}</td></tr>`;
  tbody.querySelectorAll("[data-view-booking]").forEach(button => button.addEventListener("click", () => showBookingDetails(button.dataset.viewBooking)));
  tbody.querySelectorAll("[data-delete-booking]").forEach(button => {
    button.addEventListener("click", () => requestDeleteBooking(button.dataset.deleteBooking, button.dataset.student, button.dataset.hospital));
  });
  document.querySelectorAll("[data-sort-bookings]").forEach(button => button.onclick = () => {
    const key = button.dataset.sortBookings;
    bookingSort = { key, direction: bookingSort.key === key && bookingSort.direction === "asc" ? "desc" : "asc" };
    renderAdminBookings(bookingRows);
  });
}

function renderAdminRecords() {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => loadAdminBookings().catch(showError), 200);
}

function showBookingDetails(id) {
  const booking = bookingRows.find(item => item.id === id);
  if (!booking) return;
  $("#bookingDetailsContent").innerHTML = `<dl>
    <dt>Full name</dt><dd>${esc(booking.fullName)}</dd>
    <dt>Admission number</dt><dd>${esc(booking.admissionNumber)}</dd>
    <dt>Hospital</dt><dd>${esc(booking.hospital)}</dd>
    <dt>Course</dt><dd>${esc(booking.course)}</dd>
    <dt>Campus</dt><dd>${esc(booking.campus)}</dd>
    <dt>Year of study</dt><dd>${esc(booking.yearOfStudy)}</dd>
    <dt>Status</dt><dd>${esc(booking.status)}</dd>
    <dt>Booking date</dt><dd>${esc(formatDate(booking.createdAt))}</dd>
  </dl>`;
  $("#bookingDetailsDialog").showModal();
}

async function loadConfirmedBookingHistory() {
  if (role !== "admin") return;
  const result = await api("/api/admin/bookings");
  bookingRows = result.bookings;
  renderBookingHistory(result.bookings, "Confirmed bookings");
}

function renderBookingHistory(bookings, heading) {
  const rows = bookings.map((booking, index) => `<tr><td>${index + 1}</td><td>${esc(booking.fullName)}</td><td>${esc(booking.admissionNumber)}</td><td>${esc(booking.hospital)}</td><td><span class="badge ${booking.status === "Cancelled" ? "closed" : "open"}">${esc(booking.status)}</span></td><td>${esc(formatDate(booking.createdAt))}</td>${booking.cancelledAt ? `<td>${esc(formatDate(booking.cancelledAt))}</td><td>${esc(booking.cancellationReason)}</td>` : ""}</tr>`).join("");
  const historyColumns = heading === "Cancelled bookings";
  $("#bookingHistoryContent").innerHTML = `<h4>${esc(heading)} <span class="muted">(${bookings.length})</span></h4><div class="table-wrap"><table><thead><tr><th>No.</th><th>Full name</th><th>Admission number</th><th>Hospital</th><th>Status</th><th>Booking date</th>${historyColumns ? "<th>Cancelled at</th><th>Reason</th>" : ""}</tr></thead><tbody>${rows || `<tr><td colspan="${historyColumns ? 8 : 6}">No ${heading.toLowerCase()} found.</td></tr>`}</tbody></table></div>`;
}

async function loadBookingHistory() {
  if (role !== "admin") return;
  try {
    const result = await api("/api/admin/booking-history");
    cancelledRows = result.bookings;
    renderBookingHistory(cancelledRows, "Cancelled bookings");
  } catch (error) {
    $("#bookingHistoryContent").innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
  }
}

async function refreshNotifications() {
  if (role !== "admin") return;
  const result = await api("/api/admin/notifications");
  const count = result.notifications.length;
  $("#notificationCount").textContent = count > 99 ? "99+" : String(count);
  $("#notificationCount").classList.toggle("hidden", count === 0);
  $("#notificationList").innerHTML = result.notifications.map(notification => `<li class="notification-item"><b>${esc(notification.action)}</b><span> ${esc(notification.details)}</span><small>${esc(formatDate(notification.createdAt))}${notification.administrator ? ` · ${esc(notification.administrator)}` : " · System"}</small></li>`).join("") || '<li class="muted">No notifications yet.</li>';
}

function showNotifications() {
  if (role !== "admin") return;
  refreshNotifications().then(() => $("#notificationDialog").showModal()).catch(showError);
}

async function loadAdministrators() {
  if (administratorRole !== "super_admin") return;
  const result = await api("/api/admin/administrators");
  $("#administratorTable").innerHTML = result.administrators.map(administrator => `<tr>
    <td>${esc(administrator.fullName)}</td><td>${esc(administrator.username)}</td><td>${esc(administrator.email)}</td>
    <td>${esc(administrator.role.replaceAll("_", " "))}</td>
    <td><span class="badge ${administrator.accountStatus === "Active" ? "status-active" : "status-suspended"}">${esc(administrator.accountStatus)}</span></td>
    <td>${esc(formatDate(administrator.createdAt))}</td>
    <td>${administrator.id === result.administrators.find(item => item.username === adminUsername)?.id ? "Current account" : `<button class="${administrator.suspended ? "secondary" : "danger"}" data-toggle-admin="${administrator.id}" data-suspended="${administrator.suspended ? "false" : "true"}">${administrator.suspended ? "Reactivate" : "Suspend"}</button>`}</td>
  </tr>`).join("") || '<tr><td colspan="7">No administrator accounts.</td></tr>';
  $("#administratorTable").querySelectorAll("[data-toggle-admin]").forEach(button => button.addEventListener("click", () => toggleAdministrator(Number(button.dataset.toggleAdmin), button.dataset.suspended === "true")));
}

function showAdministratorForm() {
  if (administratorRole !== "super_admin") return;
  $("#administratorForm").reset();
  $("#administratorFormPanel").classList.remove("hidden");
}

function hideAdministratorForm() {
  $("#administratorFormPanel").classList.add("hidden");
}

async function createAdministrator(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, "Sending...");
  try {
    await api("/api/admin/administrators", {
      method: "POST",
      body: JSON.stringify({
        fullName: $("#newAdminName").value,
        username: $("#newAdminUsername").value,
        email: $("#newAdminEmail").value,
        role: $("#newAdminRole").value
      })
    });
    hideAdministratorForm();
    await loadAdministrators();
    toast("Invitation sent. The account becomes active after the invitee creates their password.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleAdministrator(id, suspended) {
  if (administratorRole !== "super_admin") return;
  const account = (await api("/api/admin/administrators")).administrators.find(item => item.id === id);
  if (!account || !confirm(`${suspended ? "Suspend" : "Reactivate"} ${account.fullName}'s administrator account?`)) return;
  try {
    await api(`/api/admin/administrators/${id}/suspension`, { method: "PUT", body: JSON.stringify({ suspended }) });
    await loadAdministrators();
    toast(suspended ? "Administrator account suspended." : "Administrator account reactivated.");
  } catch (error) {
    toast(error.message, true);
  }
}

function showHospitalStudents(id) {
  hospitalStudentsId = id;
  selectAdminTab("bookings");
  loadAdminBookings().catch(showError);
}

function clearHospitalStudentsView() {
  hospitalStudentsId = null;
  loadAdminBookings().catch(showError);
}

async function loadOverview() {
  const result = await api("/api/admin/overview");
  $("#overviewBookings").textContent = result.totalBookings;
  $("#overviewHospitals").textContent = result.totalHospitals;
  $("#overviewStudents").textContent = result.totalStudents;
  $("#overviewSlots").textContent = result.availableSlots;
  $("#overviewFull").textContent = result.fullHospitals;
  $("#overviewAvailableHospitals").textContent = result.availableHospitals;
  $("#overviewLocked").textContent = result.lockedHospitals;
  $("#overviewCancelled").textContent = result.cancelledBookings;
  const rows = result.bookingsByHospital.map(hospital => `<tr><td>${esc(hospital.name)}</td><td>${esc(hospital.county)}</td><td>${hospital.bookings}</td><td>${hospital.capacity}</td><td>${hospital.availableSlots}</td><td>${hospital.occupancyRate}%</td><td><span class="badge ${hospital.full ? "full" : hospital.locked ? "closed" : "open"}">${hospital.full ? "FULL" : hospital.locked ? "LOCKED" : "OPEN"}</span></td></tr>`).join("") || '<tr><td colspan="7">No hospitals are configured.</td></tr>';
  $("#overviewHospitalTable").innerHTML = rows;
  $("#reportsHospitalTable").innerHTML = result.bookingsByHospital.map(hospital => `<tr><td>${esc(hospital.name)}</td><td>${hospital.bookings}</td><td>${hospital.capacity}</td><td>${hospital.availableSlots}</td><td>${hospital.bookings >= hospital.capacity ? "FULL" : hospital.availableSlots ? "OPEN" : "LOCKED"}</td></tr>`).join("") || '<tr><td colspan="5">No hospitals are configured.</td></tr>';
  renderDashboardCharts(result.bookingsByHospital);
}

function renderDashboardCharts(rows) {
  const chartRows = rows.slice().sort((left, right) => right.occupancyRate - left.occupancyRate);
  const barHeight = 24;
  const chartHeight = Math.max(170, chartRows.length * 31 + 24);
  const occupancyBars = chartRows.map((hospital, index) => {
    const y = index * 31 + 14;
    const label = esc(hospital.name.length > 23 ? `${hospital.name.slice(0, 22)}…` : hospital.name);
    const barWidth = Math.round(Math.max(0, Math.min(100, hospital.occupancyRate)) * 1.65);
    return `<g class="chart-interaction" data-chart-hospital="${hospital.id}" tabindex="0" role="button" aria-label="${label}, ${hospital.occupancyRate} percent occupied"><title>${esc(hospital.name)}: ${hospital.bookings} of ${hospital.capacity} slots</title><text class="chart-label" x="0" y="${y + 15}">${label}</text><rect x="172" y="${y}" width="165" height="${barHeight}" rx="5" fill="#e8eef7"/><rect x="172" y="${y}" width="${barWidth}" height="${barHeight}" rx="5" fill="${hospital.full ? "#dc2626" : "#118779"}"/><text class="chart-value" x="345" y="${y + 16}">${hospital.occupancyRate}%</text></g>`;
  }).join("");
  const allocationBars = chartRows.map((hospital, index) => {
    const y = index * 31 + 14;
    const label = esc(hospital.name.length > 23 ? `${hospital.name.slice(0, 22)}…` : hospital.name);
    const total = Math.max(1, hospital.capacity);
    const bookedWidth = Math.round((hospital.bookings / total) * 165);
    const availableWidth = Math.round((Math.max(0, hospital.capacity - hospital.bookings) / total) * 165);
    return `<g class="chart-interaction" data-chart-hospital="${hospital.id}" tabindex="0" role="button" aria-label="${label}, ${hospital.bookings} allocated, ${Math.max(0, hospital.capacity - hospital.bookings)} available"><title>${esc(hospital.name)}: ${hospital.bookings} allocated; ${Math.max(0, hospital.capacity - hospital.bookings)} capacity remaining</title><text class="chart-label" x="0" y="${y + 15}">${label}</text><rect x="172" y="${y}" width="${bookedWidth}" height="${barHeight}" rx="5" fill="#2764d8"/><rect x="${172 + bookedWidth}" y="${y}" width="${availableWidth}" height="${barHeight}" rx="5" fill="#dbeafe"/><text class="chart-value" x="345" y="${y + 16}">${hospital.bookings}/${hospital.capacity}</text></g>`;
  }).join("");
  const render = markup => `<svg viewBox="0 0 405 ${chartHeight}" role="img">${markup}</svg><p class="muted">Select a bar to view the hospital's student allocations.</p>`;
  $("#occupancyChart").innerHTML = chartRows.length ? render(occupancyBars) : '<p class="muted">No hospitals to chart.</p>';
  $("#allocationChart").innerHTML = chartRows.length ? render(allocationBars) : '<p class="muted">No hospital capacity to chart.</p>';
  document.querySelectorAll(".chart-interaction").forEach(element => {
    const openHospital = () => showHospitalStudents(Number(element.dataset.chartHospital));
    element.addEventListener("click", openHospital);
    element.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openHospital();
      }
    });
  });
}

async function loadAdminLogs() {
  const result = await api("/api/admin/logs");
  $("#logTable").innerHTML = result.logs.map(log => `<tr><td>${esc(new Date(log.createdAt).toLocaleString())}</td><td>${esc(log.administrator || "System")}</td><td>${esc(log.action)}</td><td>${esc(log.details)}</td></tr>`).join("") || '<tr><td colspan="4">No activity recorded yet.</td></tr>';
}

async function loadSettings() {
  const result = await api("/api/admin/settings");
  $("#systemSettings").innerHTML = `<p><b>Signed-in role:</b> ${esc(administratorRole.replaceAll("_", " "))}</p><p><b>Course assigned to bookings:</b> ${esc(result.course)}</p><p><b>Campus assigned to bookings:</b> ${esc(result.campus)}</p><p><b>Year of study assigned to bookings:</b> ${esc(result.yearOfStudy)}</p><p><b>Duplicate admission numbers:</b> ${result.uniqueAdmissionNumbers ? "Not allowed" : "Allowed"}</p><p><b>Administrator session length:</b> ${result.sessionLifetimeHours} hours</p><p><b>Persistent database:</b> ${esc(result.database)}</p>`;
  $("#profileFullName").value = result.profile.fullName;
  $("#profileUsername").value = result.profile.username;
  $("#profileUsername").disabled = administratorRole !== "super_admin";
  $("#profileEmail").value = result.profile.email;
}

async function saveProfile(event) {
  event.preventDefault();
  try {
    const result = await api("/api/admin/profile", {
      method: "PUT",
      body: JSON.stringify({ fullName: $("#profileFullName").value, username: $("#profileUsername").value, email: $("#profileEmail").value })
    });
    adminFullName = result.fullName;
    adminUsername = result.username;
    $("#adminUsername").textContent = adminFullName;
    if (result.credentialsChanged) {
      showStudentPortal();
      toast(result.emailVerificationRequired
        ? "Verification link sent. Verify the new email before signing in again."
        : "Username updated successfully. Sign in again with your updated credentials.");
      return;
    }
    toast("Administrator profile updated.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const newPassword = $("#newPassword").value;
  if (newPassword !== $("#confirmNewPassword").value) {
    toast("The new passwords do not match.", true);
    return;
  }
  try {
    await api("/api/admin/password", {
      method: "PUT",
      body: JSON.stringify({
        currentPassword: $("#currentPassword").value,
        newPassword,
        confirmPassword: $("#confirmNewPassword").value
      })
    });
    form.reset();
    showStudentPortal();
    toast("Password updated successfully. Sign in again with your new credentials.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function downloadDatabaseBackup() {
  if (administratorRole !== "super_admin") return;
  const button = $("#backupButton");
  setBusy(button, true, "Preparing backup...");
  try {
    const response = await fetch("/api/admin/backup", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": csrfToken, Origin: location.origin }
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Database backup could not be created.");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "attachflow-backup.sqlite";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast("Database backup downloaded.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function refreshAdmin() {
  if (role !== "admin") return;
  const result = await api("/api/admin/hospitals");
  hospitals = result.hospitals;
  renderHospitals();
  renderAdminHospitals();
  const activeSection = document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview";
  if (activeSection === "overview" || activeSection === "reports") await loadOverview();
  if (activeSection === "bookings") await loadAdminBookings();
  if (activeSection === "activity") await loadAdminLogs();
}

async function refreshAdminIfVisible() {
  if (role === "admin") await refreshAdmin();
}

async function exportReport(format) {
  if (role !== "admin") return;
  try {
    const response = await fetch(`/api/admin/export?format=${encodeURIComponent(format)}`, {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Export could not be generated.");
    }
    const blob = await response.blob();
    const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || `attachflow-report.${format}`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`${format.toUpperCase()} report downloaded.`);
  } catch (error) {
    toast(error.message, true);
  }
}

function exportStudentRecords() {
  return exportReport("xlsx");
}

async function showHospitalDeleteDialog() {
  return requestDeleteHospital();
}

function showError(error) {
  toast(error.message || "The application could not connect to the server.", true);
}

function scheduleRefresh() {
  clearTimeout(hospitalSearchTimer);
  hospitalSearchTimer = setTimeout(() => {
    loadHospitals().catch(showError);
  }, 250);
}

async function initialize() {
  $("#hospitalForm").addEventListener("submit", saveHospital);
  $("#adminLoginForm").addEventListener("submit", signInAdmin);
  $("#toggleAdminPassword").addEventListener("click", toggleAdminPassword);
  $("#openAdminRegistration").addEventListener("click", event => {
    event.preventDefault();
    $("#adminLoginDialog").close();
    showAdminRegistration();
  });
  $("#openAdminRecovery").addEventListener("click", event => {
    event.preventDefault();
    $("#adminLoginDialog").close();
    $("#adminRecoveryDialog").showModal();
  });
  $("#adminRegistrationForm").addEventListener("submit", registerAdministrator);
  $("#adminRecoveryForm").addEventListener("submit", requestAdminPasswordReset);
  $("#adminResetForm").addEventListener("submit", resetAdministratorPassword);
  $("#verifyEmailButton").addEventListener("click", verifyAdministratorEmail);
  $("#administratorForm").addEventListener("submit", createAdministrator);
  $("#profileForm").addEventListener("submit", saveProfile);
  $("#passwordForm").addEventListener("submit", changePassword);
  $("#recordHospitalFilter").addEventListener("change", () => {
    hospitalStudentsId = null;
    renderAdminRecords();
  });
  $("#search").addEventListener("input", scheduleRefresh);
  $("#countyFilter").addEventListener("change", renderHospitals);
  try {
    const [session] = await Promise.all([api("/api/session"), loadHospitals()]);
    const url = new URL(location.href);
    const inviteToken = url.searchParams.get("adminInvite");
    const verifyToken = url.searchParams.get("adminVerify");
    const resetToken = url.searchParams.get("adminReset");
    if (inviteToken || verifyToken || resetToken) history.replaceState(null, "", url.pathname);
    if (session.authenticated) {
      role = "admin";
      csrfToken = session.csrfToken;
      adminUsername = session.username;
      adminFullName = session.fullName || session.username;
      administratorRole = session.role;
      showAdminPortal();
      await refreshAdmin();
      if (location.pathname === "/admin") selectAdminTab("overview");
    } else if (new URLSearchParams(location.search).get("adminLogin") === "1") {
      showAdminLogin();
    }
    if (inviteToken) showAdminRegistration(inviteToken);
    if (verifyToken) {
      $("#verifyEmailToken").value = verifyToken;
      $("#verifyEmailError").classList.add("hidden");
      $("#adminVerifyDialog").showModal();
    }
    if (resetToken) {
      $("#resetToken").value = resetToken;
      $("#resetError").classList.add("hidden");
      $("#adminResetDialog").showModal();
    }
  } catch (error) {
    $("#hospitalGrid").innerHTML = `<div class="error-message">Unable to load hospital availability: ${esc(error.message)}. Refresh to try again.</div>`;
    showError(error);
  }
}

initialize();
