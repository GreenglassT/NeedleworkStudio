#!/usr/bin/env python3
"""CLI tool for managing users in the DMC Thread Inventory application."""

import sqlite3
import os
import sys
import getpass
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

DB_PATH = os.path.join(os.path.dirname(__file__), 'dmc_threads.db')
ph = PasswordHasher()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def create_user():
    """Create a new user."""
    username = input("Username: ").strip()
    if not username:
        print("Error: Username cannot be empty.")
        return False

    email = input("Email: ").strip()
    if not email or '@' not in email:
        print("Error: Please enter a valid email address.")
        return False

    password = getpass.getpass("Password: ")
    if len(password) < 8:
        print("Error: Password must be at least 8 characters.")
        return False

    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Error: Passwords do not match.")
        return False

    conn = get_db()
    cursor = conn.cursor()

    try:
        password_hash = ph.hash(password)
        cursor.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            (username, email, password_hash)
        )
        conn.commit()
        print(f"User '{username}' created successfully!")
        return True
    except sqlite3.IntegrityError as e:
        if 'username' in str(e):
            print(f"Error: Username '{username}' already exists.")
        elif 'email' in str(e):
            print(f"Error: Email '{email}' already exists.")
        else:
            print(f"Error: {e}")
        return False
    finally:
        conn.close()


def list_users():
    """List all users."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, email, is_active, created_at, last_login FROM users")
    users = cursor.fetchall()
    conn.close()

    if not users:
        print("No users found.")
        return

    print(f"\n{'ID':<4} {'Username':<20} {'Email':<30} {'Active':<8} {'Last Login'}")
    print("-" * 90)
    for user in users:
        active = "Yes" if user['is_active'] else "No"
        last_login = user['last_login'] or "Never"
        print(f"{user['id']:<4} {user['username']:<20} {user['email']:<30} {active:<8} {last_login}")
    print()


def change_password():
    """Change a user's password."""
    username = input("Username: ").strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()

    if not user:
        print(f"Error: User '{username}' not found.")
        conn.close()
        return False

    password = getpass.getpass("New password: ")
    if len(password) < 8:
        print("Error: Password must be at least 8 characters.")
        conn.close()
        return False

    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Error: Passwords do not match.")
        conn.close()
        return False

    password_hash = ph.hash(password)
    cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user['id']))
    conn.commit()
    conn.close()

    print(f"Password changed for user '{username}'.")
    return True


def toggle_user():
    """Enable or disable a user."""
    username = input("Username: ").strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, is_active FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()

    if not user:
        print(f"Error: User '{username}' not found.")
        conn.close()
        return False

    new_status = 0 if user['is_active'] else 1
    cursor.execute("UPDATE users SET is_active = ? WHERE id = ?", (new_status, user['id']))
    conn.commit()
    conn.close()

    status_text = "enabled" if new_status else "disabled"
    print(f"User '{username}' has been {status_text}.")
    return True


def delete_user():
    """Delete a user."""
    username = input("Username to delete: ").strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()

    if not user:
        print(f"Error: User '{username}' not found.")
        conn.close()
        return False

    confirm = input(f"Are you sure you want to delete '{username}'? (yes/no): ").strip().lower()
    if confirm != 'yes':
        print("Cancelled.")
        conn.close()
        return False

    cursor.execute("DELETE FROM users WHERE id = ?", (user['id'],))
    conn.commit()
    conn.close()

    print(f"User '{username}' deleted.")
    return True


def list_tokens():
    """List all API tokens."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT t.id, t.token, t.name, t.created_at, t.last_used_at, u.username "
        "FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC"
    )
    tokens = cursor.fetchall()
    conn.close()

    if not tokens:
        print("No API tokens found.")
        return

    print(f"\n{'ID':<4} {'User':<20} {'Name':<20} {'Created':<22} {'Last Used'}")
    print("-" * 90)
    for tok in tokens:
        last_used = tok['last_used_at'] or 'Never'
        # Show only first/last 4 chars of token
        masked = tok['token'][:4] + '...' + tok['token'][-4:]
        print(f"{tok['id']:<4} {tok['username']:<20} {tok['name']:<20} {tok['created_at']:<22} {last_used}  [{masked}]")
    print()


def revoke_token():
    """Revoke an API token by ID."""
    token_id = input("Token ID to revoke: ").strip()
    if not token_id.isdigit():
        print("Error: Token ID must be a number.")
        return False

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM api_tokens WHERE id = ?", (int(token_id),))
    if not cursor.fetchone():
        print(f"Error: Token ID {token_id} not found.")
        conn.close()
        return False

    cursor.execute("DELETE FROM api_tokens WHERE id = ?", (int(token_id),))
    conn.commit()
    conn.close()
    print(f"Token {token_id} revoked.")
    return True


def print_help():
    """Print help message."""
    print("""
DMC Thread Inventory - User Management

Usage: python manage_users.py <command>

Commands:
    create      Create a new user
    list        List all users
    password    Change a user's password
    toggle      Enable/disable a user
    delete      Delete a user
    tokens      List API tokens (sync)
    revoke      Revoke an API token
    help        Show this help message
""")


if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        print("Error: Database not found. Run 'python init_db.py' first.")
        sys.exit(1)

    if len(sys.argv) < 2:
        print_help()
        sys.exit(0)

    command = sys.argv[1].lower()

    commands = {
        'create': create_user,
        'list': list_users,
        'password': change_password,
        'toggle': toggle_user,
        'delete': delete_user,
        'tokens': list_tokens,
        'revoke': revoke_token,
        'help': print_help,
    }

    if command in commands:
        commands[command]()
    else:
        print(f"Unknown command: {command}")
        print_help()
        sys.exit(1)
