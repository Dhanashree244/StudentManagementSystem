
const API_URL = "https://student-management-backend-191c.onrender.com/api/students";

const studentForm = document.getElementById("studentForm");
const studentTable = document.getElementById("studentTable");
const totalStudents = document.getElementById("totalStudents");
const dbStatus = document.getElementById("dbStatus");
const connectionLabel = document.getElementById("connectionLabel");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
const cancelButton = document.getElementById("cancelButton");
const formTitle = document.getElementById("formTitle");
const recordId = document.getElementById("recordId");
const searchInput = document.getElementById("searchInput");
const resultMessage = document.getElementById("resultMessage");

let currentStudents = [];

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`;
}

function makeCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value ?? "";
  return cell;
}

function setConnection(connected) {
  dbStatus.textContent = connected ? "Connected" : "Unavailable";
  connectionLabel.textContent = connected ? "Connected" : "Unavailable";
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, options);

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(result.message || "The request failed.");
  }

  return result;
}

async function loadStudents(searchTerm = "") {
  studentTable.replaceChildren();

  const loadingRow = document.createElement("tr");
  const loadingCell = makeCell("Loading student records...");
  loadingCell.colSpan = 7;
  loadingRow.appendChild(loadingCell);
  studentTable.appendChild(loadingRow);

  try {
    const url = searchTerm
      ? `${API_URL}/search?q=${encodeURIComponent(searchTerm)}`
      : API_URL;

    const result = await requestJSON(url);
    currentStudents = result.data || [];

    setConnection(true);
    totalStudents.textContent = searchTerm
      ? String(result.count ?? currentStudents.length)
      : String(result.count ?? currentStudents.length);

    studentTable.replaceChildren();
    resultMessage.textContent = searchTerm
      ? `Found ${currentStudents.length} matching student(s).`
      : `Showing ${currentStudents.length} student(s).`;

    if (currentStudents.length === 0) {
      const row = document.createElement("tr");
      const cell = makeCell(
        searchTerm
          ? "No matching students found."
          : "No students yet. Add your first student above."
      );
      cell.colSpan = 7;
      row.appendChild(cell);
      studentTable.appendChild(row);
      return;
    }

    currentStudents.forEach((student) => {
      const row = document.createElement("tr");

      row.appendChild(makeCell(student.studentId));
      row.appendChild(makeCell(student.name));
      row.appendChild(makeCell(student.email));
      row.appendChild(makeCell(student.department));
      row.appendChild(makeCell(student.semester));
      row.appendChild(makeCell(student.contact));

      const actionCell = document.createElement("td");
      const actionGroup = document.createElement("div");
      actionGroup.className = "table-action";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "small-button edit-button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => {
        startEditing(student);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "small-button delete-button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => {
        deleteStudent(student._id);
      });

      actionGroup.append(editButton, deleteButton);
      actionCell.appendChild(actionGroup);
      row.appendChild(actionCell);
      studentTable.appendChild(row);
    });
  } catch (error) {
    setConnection(false);
    totalStudents.textContent = "—";
    studentTable.replaceChildren();

    const row = document.createElement("tr");
    const cell = makeCell(
      "Cannot load records. Check that the backend is running."
    );
    cell.colSpan = 7;
    row.appendChild(cell);
    studentTable.appendChild(row);

    resultMessage.textContent = error.message;
    console.error(error);
  }
}

studentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const student = {
    studentId: document.getElementById("studentId").value.trim(),
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    department: document.getElementById("department").value.trim(),
    semester: Number(document.getElementById("semester").value),
    contact: document.getElementById("contact").value.trim()
  };

  if (
    !student.studentId ||
    !student.name ||
    !student.email ||
    !student.department ||
    !student.semester ||
    !student.contact
  ) {
    showMessage("Please complete all fields.", "error");
    return;
  }

  if (!/^[0-9]{10}$/.test(student.contact)) {
    showMessage("Enter a valid 10-digit contact number.", "error");
    return;
  }

  const id = recordId.value;
  const isEditing = Boolean(id);

  submitButton.disabled = true;
  showMessage(isEditing ? "Updating student..." : "Adding student...");

  try {
    const result = await requestJSON(
      isEditing ? `${API_URL}/${encodeURIComponent(id)}` : API_URL,
      {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(student)
      }
    );

    showMessage(
      result.message ||
        (isEditing
          ? "Student updated successfully."
          : "Student added successfully."),
      "success"
    );

    resetForm();
    await loadStudents();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

function startEditing(student) {
  recordId.value = student._id;
  document.getElementById("studentId").value = student.studentId || "";
  document.getElementById("name").value = student.name || "";
  document.getElementById("email").value = student.email || "";
  document.getElementById("department").value = student.department || "";
  document.getElementById("semester").value = String(student.semester || "");
  document.getElementById("contact").value = student.contact || "";

  formTitle.textContent = "Edit Student Details";
  submitButton.textContent = "Update Student";
  cancelButton.classList.remove("hidden");
  showMessage("Edit the details and select Update Student.");

  document.getElementById("studentId").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  studentForm.reset();
  recordId.value = "";
  formTitle.textContent = "Add New Student";
  submitButton.textContent = "Add Student";
  cancelButton.classList.add("hidden");
}

cancelButton.addEventListener("click", () => {
  resetForm();
  showMessage("Editing cancelled.");
});

async function deleteStudent(id) {
  const confirmed = window.confirm(
    "Are you sure you want to delete this student record?"
  );

  if (!confirmed) return;

  try {
    const result = await requestJSON(`${API_URL}/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });

    showMessage(result.message || "Student deleted successfully.", "success");

    if (recordId.value === id) {
      resetForm();
    }

    await loadStudents(searchInput.value.trim());
  } catch (error) {
    showMessage(error.message, "error");
  }
}

document.getElementById("searchButton").addEventListener("click", () => {
  const term = searchInput.value.trim();

  if (!term) {
    showMessage("Enter a value to search.", "error");
    searchInput.focus();
    return;
  }

  showMessage("");
  loadStudents(term);
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("searchButton").click();
  }
});

document.getElementById("clearSearchButton").addEventListener("click", () => {
  searchInput.value = "";
  showMessage("");
  loadStudents();
});

document.getElementById("refreshButton").addEventListener("click", () => {
  searchInput.value = "";
  showMessage("");
  loadStudents();
});

loadStudents();
