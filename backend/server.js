const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Noor backend is running",
    project: "Noor - Voice-Based Learning Assistant",
    team: "Visionary Trio"
  });
});

app.get("/api/saved-places", (req, res) => {
  res.json([
    { name: "home", guidance: "Saved home route available on device." },
    { name: "classroom", guidance: "Saved classroom route available on device." },
    { name: "library", guidance: "Saved library route available on device." },
    { name: "lab", guidance: "Saved lab route available on device." },
    { name: "washroom", guidance: "Saved washroom route available on device." }
  ]);
});

app.get("/api/security", (req, res) => {
  res.json({
    contacts: "Contacts are stored on the user's device only.",
    cloudStorage: false,
    permissions: "Microphone, calling, SMS, and location require user/browser permission."
  });
});

app.listen(PORT, () => {
  console.log(`Noor backend running on http://localhost:${PORT}`);
});
