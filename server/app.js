const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(express.json());

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'murungaru_library',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware for authentication
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token required' });
  
  jwt.verify(token, process.env.JWT_SECRET || 'secret_key', (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Invalid token' });
    req.user = decoded;
    next();
  });
};

// User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const conn = await pool.getConnection();
    await conn.execute('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', 
      [username, hashedPassword, role || 'user']);
    conn.release();
    
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const conn = await pool.getConnection();
    const [rows] = await conn.execute('SELECT * FROM users WHERE username = ?', [username]);
    conn.release();
    
    if (rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    
    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) return res.status(401).json({ message: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'secret_key');
    res.json({ token, userId: user.id, role: user.role });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

// Get all books
app.get('/api/books', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [books] = await conn.execute('SELECT * FROM books');
    conn.release();
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching books', error: error.message });
  }
});

// Add a new book (Admin only)
app.post('/api/books', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  
  try {
    const { title, author, isbn, published_date, available_copies } = req.body;
    
    const conn = await pool.getConnection();
    await conn.execute(
      'INSERT INTO books (title, author, isbn, published_date, available_copies) VALUES (?, ?, ?, ?, ?)',
      [title, author, isbn, published_date, available_copies]
    );
    conn.release();
    
    res.status(201).json({ message: 'Book added successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error adding book', error: error.message });
  }
});

// Borrow a book
app.post('/api/transactions/borrow', verifyToken, async (req, res) => {
  try {
    const { book_id } = req.body;
    const user_id = req.user.id;
    const due_date = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
    
    const conn = await pool.getConnection();
    
    // Check book availability
    const [books] = await conn.execute('SELECT available_copies FROM books WHERE id = ?', [book_id]);
    if (books[0].available_copies <= 0) {
      conn.release();
      return res.status(400).json({ message: 'Book not available' });
    }
    
    // Create transaction
    await conn.execute(
      'INSERT INTO transactions (user_id, book_id, date_borrowed, due_date) VALUES (?, ?, NOW(), ?)',
      [user_id, book_id, due_date]
    );
    
    // Decrease available copies
    await conn.execute('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?', [book_id]);
    
    conn.release();
    res.status(201).json({ message: 'Book borrowed successfully', due_date });
  } catch (error) {
    res.status(500).json({ message: 'Error borrowing book', error: error.message });
  }
});

// Return a book
app.post('/api/transactions/return', verifyToken, async (req, res) => {
  try {
    const { transaction_id } = req.body;
    
    const conn = await pool.getConnection();
    
    // Get transaction details
    const [transactions] = await conn.execute(
      'SELECT book_id FROM transactions WHERE id = ? AND returned = FALSE',
      [transaction_id]
    );
    
    if (transactions.length === 0) {
      conn.release();
      return res.status(404).json({ message: 'Transaction not found' });
    }
    
    const book_id = transactions[0].book_id;
    
    // Mark as returned
    await conn.execute('UPDATE transactions SET returned = TRUE WHERE id = ?', [transaction_id]);
    
    // Increase available copies
    await conn.execute('UPDATE books SET available_copies = available_copies + 1 WHERE id = ?', [book_id]);
    
    conn.release();
    res.json({ message: 'Book returned successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error returning book', error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
