int public_entry(void) {
    const int value = 1;
    int *pointer = (int *)&value;
    return pointer != 0;
}
int main(void) {
    return public_entry();
}
