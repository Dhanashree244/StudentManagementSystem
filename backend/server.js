
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const connectDB = require("./db");

const app = express();

app.use(cors());
app.use(express.json());

const studentSchema = new mongoose.Schema(
  {
    studentId: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    department: {
      type: String,
      required: true,
      trim: true
    },
    semester: {
      type: Number,
      required: true,
      min: 1,
      max: 12
    },
    contact: {
      type: String,
      required: true,
      trim: true
    }
  },
  { timestamps: true }
);

const Student = mongoose.model("Student", studentSchema);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Student Information Management API is running!"
  });
});

// 1. View all students
app.get("/api/students", async (req, res) => {
  try {
    const students = await Student.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: students.length,
      data: students
    });
  } catch (error) {
    console.error("Get students error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve students."
    });
  }
});

// 2. Search students by ID, name, email or department
app.get("/api/students/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Enter a search term."
      });
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");

    const students = await Student.find({
      $or: [
        { studentId: pattern },
        { name: pattern },
        { email: pattern },
        { department: pattern }
      ]
    });

    res.json({
      success: true,
      count: students.length,
      data: students
    });
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({
      success: false,
      message: "Search failed."
    });
  }
});

// 3. Add a student
app.post("/api/students", async (req, res) => {
  try {
    const {
      studentId,
      name,
      email,
      department,
      semester,
      contact
    } = req.body;

    if (
      typeof studentId !== "string" ||
      !studentId.trim() ||
      typeof name !== "string" ||
      !name.trim() ||
      typeof email !== "string" ||
      !email.trim() ||
      typeof department !== "string" ||
      !department.trim() ||
      semester === undefined ||
      semester === "" ||
      typeof contact !== "string" ||
      !contact.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please complete all student fields."
      });
    }

    const cleanStudentId = studentId.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    const existingStudent = await Student.findOne({
      studentId: cleanStudentId
    });

    if (existingStudent) {
      return res.status(409).json({
        success: false,
        message: "This Student ID already exists."
      });
    }

    const student = await Student.create({
      studentId: cleanStudentId,
      name: name.trim(),
      email: cleanEmail,
      department: department.trim(),
      semester: Number(semester),
      contact: contact.trim()
    });

    res.status(201).json({
      success: true,
      message: "Student added successfully.",
      data: student
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicateFields = Object.keys(error.keyPattern || {});
      console.error("Duplicate key fields:", duplicateFields);

      if (duplicateFields.includes("studentId")) {
        return res.status(409).json({
          success: false,
          message: "This Student ID already exists."
        });
      }

      if (duplicateFields.includes("email")) {
        return res.status(409).json({
          success: false,
          message: "This email already exists."
        });
      }

      return res.status(409).json({
        success: false,
        message: "A duplicate value exists in the database."
      });
    }

    console.error("Add student error:", error.message);
    res.status(400).json({
      success: false,
      message: "Could not add student. Check the entered details."
    });
  }
});

// 4. Find one student by MongoDB record ID
app.get("/api/students/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student record ID."
      });
    }

    const student = await Student.findById(req.params.id);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found."
      });
    }

    res.json({ success: true, data: student });
  } catch (error) {
    console.error("Get student error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve student."
    });
  }
});

// 5. Update a student
app.put("/api/students/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student record ID."
      });
    }

    const allowed = [
      "studentId",
      "name",
      "email",
      "department",
      "semester",
      "contact"
    ];

    const updates = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] =
          typeof req.body[key] === "string"
            ? req.body[key].trim()
            : req.body[key];
      }
    }

    if (updates.email !== undefined) {
      if (
        typeof updates.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid email address."
        });
      }

      updates.email = updates.email.toLowerCase();
    }

    if (updates.semester !== undefined) {
      updates.semester = Number(updates.semester);
    }

    const student = await Student.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found."
      });
    }

    res.json({
      success: true,
      message: "Student updated successfully.",
      data: student
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicateFields = Object.keys(error.keyPattern || {});
      console.error("Update duplicate key fields:", duplicateFields);

      return res.status(409).json({
        success: false,
        message: duplicateFields.includes("studentId")
          ? "This Student ID already exists."
          : "A duplicate value exists in the database."
      });
    }

    console.error("Update student error:", error.message);
    res.status(400).json({
      success: false,
      message: "Could not update student."
    });
  }
});

// 6. Delete a student
app.delete("/api/students/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student record ID."
      });
    }

    const student = await Student.findByIdAndDelete(req.params.id);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found."
      });
    }

    res.json({
      success: true,
      message: "Student deleted successfully."
    });
  } catch (error) {
    console.error("Delete student error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not delete student."
    });
  }
});

const startServer = async () => {
  try {
    await connectDB();

    const PORT = process.env.PORT || 5000;

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Backend startup failed:", error.message);
    process.exit(1);
  }
};

startServer();
