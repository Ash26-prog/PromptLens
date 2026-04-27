1. Main idea/theme

PromptLens is a Chrome extension that enhances user prompts in real-time across AI platforms like ChatGPT, Gemini,Claude etc. It transforms low-quality prompts into optimized, high-quality prompts while explaining the improvements, helping users learn prompt engineering via explaination.


## 🌟 Features

- ⚡ One-click prompt refinement  
- 🧠 AI-powered optimization using Google Gemini  
- 📊 Prompt quality scoring  
- 📖 Clear explanation of improvements  
- 🔁 Real-time feedback loop for learning  
- 🔐 Secure authentication using Firebase  

---

## 🧩 How It Works

1. User enters a prompt in an AI tool  
2. PromptLens analyzes the input  
3. Applies structured prompt engineering principles  
4. Sends request to Gemini API  
5. Generates:
   - Refined prompt  
   - Quality score  
   - Explanation  
6. Displays output instantly to the user  

---

## 🏗️ Tech Stack

### Frontend
- Chrome Extension (JavaScript, HTML, CSS)

### Backend
- Firebase (Authentication & Firestore)

### AI Layer
- Google Gemini API

### Integration
- Chrome Identity API  
- REST APIs  

---

## 🔐 Security Notes

- Firebase API key is restricted to required APIs only  
- Firestore access is controlled via authentication rules  
- No sensitive credentials are exposed beyond standard client configuration  

---

## 📦 Installation

### 1. Clone the repository
```bash
git clone https://github.com/Ash26-prog/PromptLens.git
cd PromptLens
2. Load extension in Chrome
Go to chrome://extensions/
Enable Developer Mode
Click Load unpacked
Select the project folder
▶️ Usage
Open any AI platform (ChatGPT, Gemini, etc.)
Type a prompt
Click Refine using PromptLens
View:
Improved prompt
Score
Explanation
🔮 Future Improvements
Personalized prompt suggestions
Multi-language support
Integration with IDEs
Advanced analytics and user insights
Support for multiple AI models
📌 Project Goal

To bridge the gap between AI capability and user skill by making prompt engineering intuitive, accessible, and learnable through real-time usage.

👤 Author

Ash M
GitHub: https://github.com/Ash26-prog

📄 License

This project is for educational and prototype purposes.
