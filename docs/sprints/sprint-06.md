# Sprint 06: Authentication & UI Refinement

**Duration**: 3-4 days
**Goal**: Implement authentication system and enhance user interface

---

## Objectives

1. Implement authentication system
2. Create login page
3. Protect settings and admin pages
4. Enhance dashboard UI
5. Improve settings page organization
6. Add device connection status indicators

---

## Tasks

### 6.1 Authentication Manager
- [x] Create `src/auth/AuthManager.js`:
  - User login/logout
  - Password hashing (bcryptjs)
  - Token generation (simple tokens)
  - Session management
  - Token expiration handling
- [x] IPC handlers:
  - `login` (email, password) → token
  - `logout` (token) → success
  - `validate-token` (token) → user or null
  - `change-password` (oldPassword, newPassword) → success

### 6.2 Auth Middleware
- [x] Create `src/auth/AuthMiddleware.js`:
  - For API server endpoints
  - Token validation
  - Role-based access control

### 6.3 Login Page
- [ ] Create `pages/login.html`:
  - Email/password form
  - Remember me option
  - Error messages
  - Redirect to dashboard on success
- [ ] Style consistent with existing UI
- [ ] Add to preload API exposure

### 6.4 Protected Pages
- [ ] Implement page protection:
  - **Public**: Dashboard (read-only view)
  - **Protected**: Settings, Device Management
- [ ] Add login check on window load
- [ ] Redirect to login if unauthorized

### 6.5 Dashboard Enhancement
- [ ] Redesign `pages/index.html`:
  - Modern card-based layout
  - **Mobile Mode**: Step-through axle capture workflow
  - **Multideck Mode**: Simultaneous 4-deck status cards
  - GVW prominent display
  - Connection status indicators
  - Vehicle on deck indicator
- [ ] Real-time animations for weight changes
- [ ] Color-coded status

### 6.6 Settings Page Organization
- [ ] Reorganize `pages/settings.html`:
  - **General Tab**: Station info, theme, capture mode
  - **Indicators Tab**: Input config
  - **Outputs Tab**: Output config
  - **Simulation Tab**: Simulation settings
  - **Authentication Tab**: User management
  - **About Tab**: Developer info, version
- [ ] Tab navigation
- [ ] Save/Cancel/Reset buttons
- [ ] Validation feedback

### 6.7 Connection Status
- [ ] Real-time connection indicators:
  - Per-device status
  - Last data received timestamp
  - Retry count/status
- [ ] System tray icon color based on status

### 6.8 About Section
- [x] Add about section with developer info (in defaults.js):
  - Developer: Titus Owuor
  - Company: Covertext IT Solutions
  - Address: Oginga Street, Kisumu
  - Tel: +254743793901
  - Version number

---

## Deliverables

1. Authentication system with login/logout
2. Login page UI
3. Protected settings pages
4. Enhanced dashboard design
5. Organized settings page with tabs
6. Connection status indicators
7. About section

---

## Verification

### Authentication Test
1. Start app fresh (database recreated)
2. Verify admin user seeded
3. Navigate to settings
4. Verify redirect to login
5. Login with admin@truconnect.local / Admin@123!
6. Verify access to settings

### UI Test
1. Review dashboard layout
2. Check weight displays update correctly
3. Verify connection status indicators
4. Test settings page tabs
5. Verify theme switching (light/dark)
