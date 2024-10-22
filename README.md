# Local AstroDB Viewer

View and interact with `.db` files directly in Visual Studio Code.

## Features

- **Open Database**: Open a `.db` file and view its schema.
- **Data Editing**: Edit table data and save changes back to the database.
- **Tree View**: Navigate tables and columns using a tree view panel.

## Usage

1. **Open a Database**:
   - Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac).
   - Run `Local AstroDB: Open .db file`.
   - Select a `.db` file.

2. **View Database Schema**:
   - Use the **Local AstroDB Viewer** in the Activity Bar to explore tables and columns.

3. **View Table Data**:
   - Click on a table in the tree view to view its data.
   - Choose to display data as a file or in a table view.

4. **Edit Data**:
   - In the table view, edit data directly in the cells.
   - Click `Save Changes` to update the database.


## Requirements

- Node.js
- Visual Studio Code

## Extension Settings

No additional settings required.

## Known Issues

- Editing data assumes the first column is a primary key.
- Be cautious with executing custom queries.

## Release Notes

### 1.0.0

- Initial release with all features.

### 1.1.0

- Logo Update (still not final)

### 1.2.0

- Added Table view.

### 1.3.0

- Fixed some minor bugs.


### 1.4.0

- Auto fetch db.
- Fixed Icon in Activity bar
- Added refresh to table view 
- In Tree View show data types

### Future development

- Save changes to seed file 
- Allow users to add new row
- Allow users to delete row
- Refresh data, on seed file watch
- UI Refresh
- Logo Refresh

If there is anything you think should be added or fixed, let me know 

---

**Enjoy using Local AstroDB Viewer!**
