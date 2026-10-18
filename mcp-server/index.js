
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL =
  "https://student-management-backend-191c.onrender.com/api/students";

const server = new McpServer({
  name: "student-management-mcp",
  version: "1.0.0"
});

async function searchStudentRecords(query) {
  const url = new URL(`${API_URL}/search`);
  url.searchParams.set("q", query);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Student API returned status ${response.status}`);
  }

  const result = await response.json();

  if (!result.success || !Array.isArray(result.data)) {
    throw new Error("Unexpected response from the student API.");
  }

  return result.data;
}

function safeStudentDetails(student) {
  return {
    studentId: student.studentId,
    name: student.name,
    department: student.department,
    semester: student.semester
  };
}

server.tool(
  "search_students",
  {
    query: z.string().min(1).max(100).describe(
      "Search by student ID, name, email, or department"
    )
  },
  async ({ query }) => {
    try {
      const students = await searchStudentRecords(query);

      const safeResults = students.map(safeStudentDetails);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(safeResults, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error("Student search failed:", error.message);

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Unable to search students. Check the backend service and try again."
          }
        ]
      };
    }
  }
);

server.tool(
  "get_student_details",
  {
    studentId: z.string().min(1).max(100).describe(
      "The exact Student ID to look up"
    )
  },
  async ({ studentId }) => {
    try {
      const students = await searchStudentRecords(studentId.trim());

      const student = students.find(
        item =>
          String(item.studentId || "").trim().toLowerCase() ===
          studentId.trim().toLowerCase()
      );

      if (!student) {
        return {
          content: [
            {
              type: "text",
              text: "No student found with that Student ID."
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(safeStudentDetails(student), null, 2)
          }
        ]
      };
    } catch (error) {
      console.error("Student lookup failed:", error.message);

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Unable to retrieve student details. Check the backend service and try again."
          }
        ]
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
