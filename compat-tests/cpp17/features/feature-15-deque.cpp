#include <deque>
#include <iostream>
int main(){ std::deque<int> d{2,3}; d.push_front(1); std::cout<<d.front()+d.back()<<"\n"; }
