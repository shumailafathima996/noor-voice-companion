# **Noor — Voice Companion 🕊️**

**Noor** (meaning *“Light”*) is an **offline‑first voice‑based learning assistant** designed to empower blind and low‑vision users with independence, safety, and productivity. Built with accessibility at its core, Noor provides critical daily support through intuitive voice commands and privacy‑first design.

---

## **🚩 Problem Statement**
Blind and low‑vision individuals face daily challenges in:
- Quickly accessing emergency services  
- Navigating indoor spaces independently  
- Managing health routines like medicine and hydration  
- Staying productive with study or daily planning tools  

Existing solutions are often cloud‑dependent, slow, or lack inclusive design. Noor solves this by being **local, fast, and accessible**.

---

## **💡 Solution Overview**
Noor is a **web‑based voice companion** that runs directly in the browser, requiring no external servers.

**Core Features**:
- Voice‑based learning support  
- Family contact calling  
- Medicine reminders  
- Emergency SOS assistance  
- Location sharing  
- Indoor guidance support  
- Saved‑place offline guidance  
- New‑place fallback support  
- Secure local contact storage  

**Wake Word**: *“Hey Friend”* for low‑friction interaction.

---

## **🌍 UN SDG Global Impact**
- **SDG Goal 4: Quality Education** – Accessible educational support through voice interaction  
- **SDG Goal 10: Reduced Inequalities** – Reduces accessibility barriers for visually impaired individuals  
- **SDG Goal 3: Good Health and Well‑being** – Supports emergency assistance and medicine reminders  

---

## **📖 Installation Guide**

### **Frontend**
1. Open the folder `Noor_Project_VisionaryTrio` in VS Code  
2. Go to `frontend/index.html`  
3. Right‑click → *Open with Live Server*  
4. Allow microphone permission  
5. Press **Space** or **Enter** once  
6. Say *“Hey Friend”* and interact with Noor  

### **Backend**
1. Open terminal in VS Code  
2. Run:  
   ```bash
   cd backend
   npm install
   npm start
Backend runs at: http://localhost:5000

🏗️ System Architecture
plaintext
+-------------------+
|   User Voice      |
+-------------------+
        |
        v
+-------------------+        +-------------------+
| SpeechRecognition | -----> | Command Processor |
+-------------------+        +-------------------+
        |                           |
        v                           v
+-------------------+        +-------------------+
| LocalStorage Data |        | SpeechSynthesis   |
| (contacts, notes) |        | (voice feedback)  |
+-------------------+        +-------------------+
        |
        v
+-------------------+
| Emergency / Share |
+-------------------+
🔒 Privacy & Safety
Zero‑Cloud Philosophy: All processing happens locally

Contacts & Notes: Stored securely in localStorage

Speech Recognition: Handled by the browser’s native engine

Emergency Features: Intent‑based triggers with user confirmation

🗺️ Offline Guidance Clarification
Noor can guide users offline only to saved places (home, classroom, lab, library, washroom).

For new places, Noor informs the user that the route is not saved offline and suggests:

Connecting to the internet

Calling a trusted family contact

Sharing location for help

🎥 Demo
Open index.html in your browser

Unlock microphone (Space/Enter)

Try wake word and commands

Observe waveform visualization and spoken feedback

🖼️ Final Gallery
Screenshots (examples):

Noor Home Interface

Voice Assistant Features:

Family contact calling

Indoor guidance support

Location sharing

Medicine reminders

Emergency SOS assistance

Voice‑based learning support

Saved‑place offline guidance

Secure contact handling

🛠️ Technologies Used
HTML, CSS, JavaScript

Web Speech API

Browser Geolocation API

Local Storage

Node.js, Express.js

🚀 Future Scope
Support multiple regional languages

AI‑powered personalized learning assistance

Real‑time object detection for visually impaired users

Improved emergency response & caretaker notifications

PWA installation support

Secure login & encrypted contact storage

👥 Team Details
Team Name: Visionary Trio
Project: Noor – Voice Based Learning Assistant for Visually Impaired Users

Credits:

Shumaila Fathima

B. Srividya

Azmath Fatima

📂 Project Structure
plaintext
frontend/
  index.html
  styles.css
  script.js

backend/
  server.js
  package.json

README.md
📄 License
Licensed under the MIT License. See the LICENSE file for details.

🤝 Contributing
Contributions are welcome!

Open issues for accessibility improvements

Submit pull requests for new voice‑guided features

✨ Built with ❤️ for independence.