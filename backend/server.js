
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
      !studentId?.trim() ||
      !name?.trim() ||
      !email?.trim() ||
      !department?.trim() ||
      semester === undefined ||
      semester === "" ||
      !contact?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please complete all student fields."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    const student = await Student.create({
      studentId,
      name,
      email,
      department,
      semester: Number(semester),
      contact
    });

    res.status(201).json({
      success: true,
      message: "Student added successfully.",
      data: student
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This Student ID already exists."
      });
    }

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

    if (updates.semester !== undefined) {
      updates.semester = Number(updates.semester);
    }

    if (
      updates.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
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
      return res.status(409).json({
        success: false,
        message: "This Student ID already exists."
      });
    }

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

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Backend startup failed.");
    process.exit(1);
  }
};

startServer();
